/**
 * hanja-guard — 한자/가나(한자·가나) 혼입 가드
 *
 * 특정 모델이 파일에 한자(漢字)/가나를 가끔 혼입하는 문제를 잡는다.
 *
 * 동작:
 *  1. edit / write / ast_grep_replace(apply:true) / bash(> >> tee sed -i cp mv) 실행에
 *     성공한 파일(tool_result, !isError)을 현재 run의 dirty 세트로 추적한다.
 *  2. run 종료 경계(agent_before_settle)에서 dirty 파일을 스캔해 한자/가나를 찾는다.
 *     (정규식: CJK 통합한자 + 확장A/B-F + 호환 한자 + 라디컬 + 〇/々 + 가나 + 반각)
 *  3. 감지되면 발생 위치(파일:행:열 + 문자 + 컨텍스트)를 나열한 custom_message를 세션에
 *     커밋하고 continue: true 로 다음 턴(continuation)을 요청 → 모델이 의도한 단어로 치환.
 *     (의미 판단이 필요해서 치환은 모델이 수행. extension은 결정적 감지만 한다.)
 *  4. 루프 보호:
 *     - 같은 시그니처(위치 목록)가 maxRoundsSameSig(2)회 연속이면 stall
 *     - 시그니처가 매 라운드 바뀌는 변형 시도에도 totalRounds(4) 총상한
 *     - stall 시 문제 파일은 muted 로 이동(새 파일 스캔 슬롯을 차지하지 않음) + 1회 알림
 *     - 다음 사용자 run(agent_start, continuation 아님)에서 카운터 re-arm → 재시도
 *     - muted 파일은 자동 복원 안 함: 해당 파일이 다시 수정되면 자동 re-track, /hanja --unmute로 수동 해제
 *       (매 run마다 무조건 되살리면 "의도적 CJK" 파일이 매 사용자 턴마다 자동치환+stall 반복되는 UX 루프가 생김)
 *     - scan이 clean이면 카운터 리셋 (muted는 유지)
 *  5. abort 시: 커밋된 entry(지시문)는 transcript에 남아 다음 사용자 턴에 모델이 본다.
 *     continuation은 억제됨(문서 보장).
 *
 * 수동 검사: /hanja <path>... (인자 없으면 pending 파일 검사) | /hanja --unmute
 * 설정: CFG(아래) 직접 수정 또는 env PI_HANJA_SKIP (쉼표 구분 glob) 로 추가 스킵 패턴.
 * 디버그: PI_HANJA_DEBUG=1 로 상태 머신 로그 출력.
 *
 * 주의: /reload 시 모듈 재로딩으로 in-memory 상태(dirty/muted/카운터)가 초기화된다.
 *       그 턴의 수정 파일은 다음 턴에 다시 수정하면 재추적된다. 허용되는 trade-off.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 한자/가나 감지 정규식 (테스트용 export — non-global: 외부 .test() 시 상태 공유 방지) */
export const HANJA_RE =
  /[\u2E80-\u2EFF\u2F00-\u2FDF\u3007\u3021-\u3029\u3041-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2EBEF}\uFF66-\uFF9D]/u;
/** 내부 스캔용 global 버전 (scanFile은 sync라서 이벤트 루프 인터리브 불가) */
const HANJA_RE_G = new RegExp(HANJA_RE.source, "gu");

const envSkip = (process.env.PI_HANJA_SKIP ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const CFG = {
  maxOccurrencesPerFile: 30, // 파일당 보고 최대 hit 수
  maxInstructionHits: 60, // 모델 지시문에 나열할 최대 hit 수
  maxFileBytes: 2_000_000, // 이보다 큰 파일은 스킵
  maxRoundsSameSig: 2, // 동일 시그니처 연속 라운드 상한 (그냥 안 고칠 때)
  maxTotalRounds: 4, // run당 continuation 총상한 (sig가 매번 바뀌는 변형 시도 방지)
  // 정당한 ja/zh 콘텐츠 파일 기본 스킵 (오탐 방지 — 이 파일들에 한자는 정상이다)
  skipGlobs: [
    "**/locales/{ja,zh}*/**",
    "**/locale/{ja,zh}*/**",
    "**/i18n/{ja,zh}*/**",
    "**/*.{ja,zh}.*",
    "**/vendor/**",
    "**/node_modules/**",
    ...envSkip,
  ],
} as const;

export interface HanjaHit {
  file: string; // cwd 상대 경로 (display)
  line: number; // 1-based
  col: number; // 1-based, UTF-16 code unit 기준 (astral 문자 뒤 1단위 오차 가능)
  char: string;
  context: string; // 해당 줄 trim + 120자 클립
}

// glob → RegExp: `**` + `/` = (?:.*/)? (0개 이상 디렉토리, root 포함), 단독 `**` = .*,
// `*` = [^/]*, `?` = [^/], `{a,b}` = (?:a|b) (내부 glob 재귀 변환)
export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${convertGlob(glob)}$`);
}

function convertGlob(s: string): string {
  let re = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "*") {
      if (s[i + 1] === "*") {
        // `**/` (slash 이을 때) → 0개 이상 디렉토리; 단독/기타 `**` → 아무 문자
        if (s[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i++;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const close = s.indexOf("}", i); // 중첩 중괄호 미지원
      if (close === -1) {
        re += "\\{"; // 리터럴 { 로 취급
      } else {
        const alts = s
          .slice(i + 1, close)
          .split(",")
          .map((a) => convertGlob(a));
        re += `(?:${alts.join("|")})`;
        i = close;
      }
    } else {
      re += c.replace(/[.*+^$()|[\]\\]/g, "\\$&");
    }
  }
  return re;
}

/** 파일에서 한자/가나 hit 목록을 찾는다. (sync, 실패 시 []) */
export function scanFile(abs: string, rel: string): HanjaHit[] {
  let text: string;
  try {
    if (statSync(abs).size > CFG.maxFileBytes) return [];
    text = readFileSync(abs, "utf8");
  } catch {
    return [];
  }
  if (text.slice(0, 4096).includes("\u0000")) return []; // 바이너리
  const hits: HanjaHit[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && hits.length < CFG.maxOccurrencesPerFile; i++) {
    const line = lines[i];
    HANJA_RE_G.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HANJA_RE_G.exec(line)) !== null && hits.length < CFG.maxOccurrencesPerFile) {
      hits.push({ file: rel, line: i + 1, col: m.index + 1, char: m[0], context: line.trim().slice(0, 120) });
    }
  }
  return hits;
}

/** 모델에게 보낼 치환 지시문 (Korean) */
function buildInstruction(hits: HanjaHit[]): string {
  const shown = hits.slice(0, CFG.maxInstructionHits);
  const more = hits.length > shown.length ? `\n(…${hits.length - shown.length}건 더 있음)` : "";
  return [
    "[hanja-guard] 전 턴에서 수정한 파일에 한자/가나 혼입이 감지되었습니다. 아래 각 위치의 한자를 문맥상 의도한 단어(한글/영어)로 치환하세요.",
    ...shown.map((h) => `- ${h.file}:${h.line}:${h.col} ${h.char} (컨텍스트: ${h.context})`),
    more,
    "지침:",
    "1. 한자가 명백한 오타/혼입인 경우(한글 문장·영문 코드의 한가운데, 깨진 단어) → 의도한 정상 단어로 치환.",
    "2. 의도적으로 쓴 CJK(인용, locale 데이터, 문서, 고어/외래어)로 판단되면 치환하지 말고 답신에서 사유만 설명.",
    "3. 파일의 그 외 부분은 절대 변경하지 마라.",
    "4. 완료 후 `rg -no '\\p{Han}|\\p{Hiragana}|\\p{Katakana}' <파일>` 로 잔존 확인하고 그 결과를 답신에 포함.",
  ].join("\n");
}

/**
 * bash 커맨드에서 파일 쓰기 타깃 추출: > / >> 리다이렉션(따옴표 포함), tee, sed -i, cp/mv 목적지.
 * 추출된 후보는 전부 stat 게이트(실행 후 파일 존재 확인)를 거치므로 오탐은 무해하다.
 */
export function extractBashWriteTargets(command: string): string[] {
  const targets = new Set<string>();
  const clean = (t: string) => t.trim().replace(/^["']|['"]$/g, "");
  // 캡처: "..." | '...' | 맨 토큰 (따옴표/백쿼크/괄호/공백/분리문자에서 끊김)
  const QD = '"[^"]+"';
  const QS = "'[^']+'";
  const BARE = "[^\\s;|&<>`'\"(]+";
  const PATH = `(${QD}|${QS}|${BARE})`;
  const add = (t: string) => {
    const c = clean(t);
    if (c && !c.startsWith("$") && c !== "/dev/null") targets.add(c);
  };
  for (const line of command.split(/\n/)) {
    // >> (fd 접두 허용: 1>>, &>>) — `>` 직전이어서 단일 > 패턴과 중복 안 됨
    const dd = new RegExp("(?:\\d+)?&?>>\\s*" + PATH, "g");
    // 단일 > (숫자/> 직전이면 제외: 1>, >>; &> 는 허용)
    const sd = new RegExp("(?<![\\d<>])>\\s*" + PATH, "g");
    for (const re of [dd, sd]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) add(m[1]);
    }
    // tee
    const tee = new RegExp("\\btee\\s+(?:-[a-z]+\\s+)*" + PATH, "g");
    let m2: RegExpExecArray | null;
    while ((m2 = tee.exec(line)) !== null) add(m2[1]);
    // sed -i: -i 이후 모든 비옵션 토큰 후보 (macOS `sed -i '' 's/a/b/' file`, GNU `sed -i -e 's/a/b/' file`)
    if (/\bsed\b/.test(line) && /(^|\s)-i\S*/.test(line)) {
      const toks = line.split(/\s+/);
      const iIdx = toks.findIndex((t) => /^-i/.test(t));
      for (let j = iIdx + 1; j < toks.length; j++) {
        if (clean(toks[j]) === "") continue; // macOS 빈 백업 인자 ('')
        if (/^-/.test(toks[j])) {
          if (/^-[efE]$/.test(toks[j])) j++; // -e/-f는 표현식 인자를 소비
          continue;
        }
        if (!clean(toks[j]).startsWith("$")) add(toks[j]);
      }
    }
    // cp/mv: 마지막 비옵션 인자가 목적지
    const all = line.split(/\s+/);
    const cmdIdx = all.findIndex((t) => t === "cp" || t === "mv");
    if (cmdIdx !== -1) {
      const last = [...all.slice(cmdIdx + 1)].reverse().find((t) => t !== "" && !t.startsWith("-"));
      if (last) add(last);
    }
  }
  return [...targets];
}

// 파일 전체를 스캔한다 (cap 없음 — scanFile은 크기 가드+조기종료라 수십 파일 sync 스캔이 settle 비용으로 무시할 수준.
// 파일 수 캡은 16번째 이후(=가장 나중에 수정된) 파일들을 경고 없이 버리는 실수가 있었음)
export function collectHits(dirty: Iterable<string>, cwd: string, skipRes: RegExp[]): {
  hits: HanjaHit[];
  absOfRel: Map<string, string>;
} {
  const hits: HanjaHit[] = [];
  const absOfRel = new Map<string, string>();
  for (const abs of dirty) {
    const rel = isAbsolute(abs) ? relative(cwd, abs) || abs : abs;
    if (skipRes.some((re) => re.test(rel) || re.test(abs))) continue;
    absOfRel.set(rel, abs); // hit.file(rel) → abs 조회용 (stall 시 muted 이동)
    hits.push(...scanFile(abs, rel));
  }
  return { hits, absOfRel };
}

/** stall: hit 파일들을 dirty에서 제외하고 muted로 이동 (re-track/unmute까지 조용히 방치 방지) */
export function muteHits(dirty: Set<string>, muted: Set<string>, hits: HanjaHit[], absOfRel: Map<string, string>): void {
  for (const h of hits) {
    const abs = absOfRel.get(h.file);
    if (abs) {
      dirty.delete(abs);
      muted.add(abs);
    }
  }
}

const DBG = process.env.PI_HANJA_DEBUG === "1";
const dbg = (...args: unknown[]) => {
  if (DBG) console.error("[hanja-guard:dbg]", ...args);
};

export default function (pi: ExtensionAPI) {
  const dirty = new Set<string>(); // 현재 run에서 수정된 파일 (절대경로)
  const muted = new Set<string>(); // stall 후 일시정지된 파일 — 수정 시 자동 re-track
  const state = {
    lastSig: null as string | null, // 직전 flag한 hit 시그니처
    rounds: 0, // 동일 시그니처 연속 라운드
    totalRounds: 0, // arm 주기에 따른 continuation 총 횟수 (무한 루프 하드 캡)
    stalledReported: false,
    awaitingContinuation: false, // continue: true 요청 후 다음 agent_start가 ours인지 판별
  };
  const skipRes = CFG.skipGlobs.map(globToRegExp);

  const resetCounters = () => {
    state.lastSig = null;
    state.rounds = 0;
    state.totalRounds = 0;
    state.stalledReported = false;
  };

  // re-arm: 카운터만 리셋. muted 파일은 자동 복원하지 않는다 —
  // (a) 해당 파일이 다시 수정되면(tool_result) 자동으로 unmute+재추적되고,
  // (b) /hanja --unmute 로 수동 해제.
  const rearm = () => {
    resetCounters();
  };

  pi.on("session_start", () => {
    dirty.clear();
    muted.clear();
    resetCounters();
    state.awaitingContinuation = false;
    dbg("session_start");
  });

  pi.on("agent_start", () => {
    dbg("agent_start awaiting=", state.awaitingContinuation);
    if (state.awaitingContinuation) {
      // 이 run이 우리가 요청한 continuation → 가드 상태 유지 (리셋하면 루프 캡이 무력화됨).
      // abort로 continuation이 억제된 경우 이 플래그가 true로 남아 다음 run이 한 턴 밀려 re-arm —
      // 보수적 방향(캡 유지)이라 허용.
      state.awaitingContinuation = false;
      return;
    }
    // 새 사용자 run → 카운터 리셋 (muted 파일은 수정 시 자동 re-track)
    rearm();
  });

  // 파일 수정 툴 성공 시 dirty 추적 (tool_result: isError=false 면만)
  pi.on("tool_result", (event, ctx) => {
    if (event.isError) return;
    const input = (event.input ?? {}) as Record<string, unknown>;
    let candidates: unknown[] = [];
    if (event.toolName === "edit" || event.toolName === "write") {
      candidates = [input.path];
    } else if (event.toolName === "ast_grep_replace" && input.apply === true) {
      candidates = Array.isArray(input.paths) ? input.paths : [];
    } else if (event.toolName === "bash") {
      // bash 기반 파일 수정(> / >> / tee / sed -i / cp / mv)도 추적
      candidates = extractBashWriteTargets(String(input.command ?? ""));
    } else {
      return;
    }
    for (const p of candidates) {
      if (typeof p !== "string" || !p) continue;
      const abs = isAbsolute(p) ? p : resolve(ctx.cwd, p);
      if (event.toolName === "write") {
        dirty.add(abs); // write는 실행 후 파일이 반드시 존재
        muted.delete(abs); // 수정된 muted 파일 → 자동 재추적 ("다시 고쳐봐" 경로)
        continue;
      }
      try {
        if (statSync(abs).isFile()) {
          dirty.add(abs); // bash/ast_grep_replace: 실행 후 파일 확인 (디렉토리·없는 파일은 스킵)
          muted.delete(abs);
        }
      } catch {
        /* 파일이 없으면 무시 */
      }
    }
  });

  pi.on("agent_before_settle", (event, ctx) => {
    try {
      if (dirty.size === 0) {
        dbg("settle: dirty empty, skip");
        return;
      }
      const cwd: string = ctx.cwd;
      const { hits, absOfRel } = collectHits(dirty, cwd, skipRes);
      dbg(`settle: dirty=${dirty.size} hits=${hits.length}`);

      // clean: 카운터 리셋. muted는 그대로 유지 (stall 파일 — 수정 시 자동 re-track, /hanja --unmute로 수동 해제)
      if (hits.length === 0) {
        const wasPending = state.lastSig !== null || state.stalledReported;
        dirty.clear();
        resetCounters();
        state.awaitingContinuation = false;
        if (wasPending && ctx.ui) ctx.ui.notify("hanja-guard: 한자 잔존 0건 — 수정 완료", "info");
        return;
      }

      const sig = hits.map((h) => `${h.file}:${h.line}:${h.col}:${h.char}`).sort().join("|");

      const stall = () => {
        // 문제 파일만 muted 로 이동 → 새 파일 스캔 슬롯을 차지하지 않음
        muteHits(dirty, muted, hits, absOfRel);
        if (!state.stalledReported) {
          state.stalledReported = true;
          ctx.ui?.notify(
            `hanja-guard: 자동 치환 중단 (잔존 ${hits.length}건) — /hanja <파일> 로 확인하거나 메시지 보내면 재시도`,
            "warning",
          );
        }
      };

      // 1) 하드 캡: 총 continuation 횟수 (sig가 매번 바뀌어도 bounded)
      // 2) soft 캡: 동일 시그니처 연속 (모델이 아예 안 고칠 때)
      if (state.totalRounds >= CFG.maxTotalRounds || (state.lastSig === sig && state.rounds >= CFG.maxRoundsSameSig)) {
        dbg(`settle: STALL totalRounds=${state.totalRounds} sameSig=${state.lastSig === sig}`);
        stall();
        state.awaitingContinuation = false;
        return; // continue 없음 → 루프 종료
      }
      if (state.lastSig === sig) {
        state.rounds++;
      } else {
        state.lastSig = sig;
        state.rounds = 1;
        state.stalledReported = false; // sig가 바뀌면 stall 알림 재아밍
      }
      state.totalRounds++;
      state.awaitingContinuation = true;
      dbg(`settle: CONTINUE totalRounds=${state.totalRounds} rounds=${state.rounds} hits=${hits.length}`);
      if (ctx.ui) {
        ctx.ui.notify(`hanja-guard: 한자 ${hits.length}건 감지 — 다음 턴 자동 치환 (라운드 ${state.totalRounds}/${CFG.maxTotalRounds})`, "info");
      }
      return {
        entries: [
          ...event.entries,
          { type: "custom_message", customType: "hanja-guard", content: buildInstruction(hits), display: true },
        ],
        continue: true,
      } as const;
    } catch (err) {
      console.error("[hanja-guard] settle handler:", err);
    }
  });

  // 수동 검사: /hanja <path>... | 인자 없으면 pending(dirty+muted) 파일 | --unmute 로 muted 해제
  pi.registerCommand("hanja", {
    description: "파일에서 한자/가나 혼입 검사: /hanja <path>... | --unmute",
    handler: async (args: string, ctx) => {
      const argsRaw = (args ?? "").trim();
      if (argsRaw === "--unmute") {
        const n = muted.size;
        for (const m of muted) dirty.add(m);
        muted.clear();
        resetCounters();
        ctx.ui.notify(`hanja-guard: ${n}개 파일 재검사 대기`, "info");
        return;
      }
      const paths = argsRaw.split(/\s+/).filter(Boolean);
      const list = paths.length ? paths : [...dirty, ...muted].map((a) => relative(ctx.cwd, a) || a);
      if (!list.length) {
        ctx.ui.notify("hanja-guard: pending 파일 없음 (clean)", "info");
        return;
      }
      if (list.length > 20) console.log(`[hanja-guard] …${list.length - 20}개 더 있음 (경로를 명시해 다시 실행)`);
      let total = 0;
      for (const p of list.slice(0, 20)) {
        const abs = isAbsolute(p) ? p : resolve(ctx.cwd, p);
        const rel = isAbsolute(abs) ? relative(ctx.cwd, abs) || abs : p;
        const hits = scanFile(abs, rel);
        total += hits.length;
        console.log(`[hanja-guard] ${rel}: ${hits.length ? `${hits.length}건` : "clean"}`);
        for (const h of hits.slice(0, 20)) console.log(`  ${h.file}:${h.line}:${h.col} ${h.char} (${h.context})`);
      }
      ctx.ui.notify(total ? `hanja-guard: 한자 ${total}건 감지됨` : "hanja-guard: clean", total ? "warning" : "info");
    },
  });
}
