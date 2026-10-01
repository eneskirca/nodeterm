// xterm.js 5.5.0's VT500 parser table, for the stream filter's differential test (test-only).
//
// The six blocks between the BEGIN/END markers are copied VERBATIM from the installed package:
//   node_modules/@xterm/xterm/src/common/parser/Constants.ts            ParserState, ParserAction
//   node_modules/@xterm/xterm/src/common/parser/EscapeSequenceParser.ts TableAccess, TransitionTable,
//                                                                       NON_ASCII_PRINTABLE,
//                                                                       VT500_TRANSITION_TABLE
// `stream-filter.xterm.test.ts` compares each block with that source, so an xterm upgrade that
// changes the table fails there instead of silently testing the filter against an old model.
// Only the code after the END marker is ours; the lines of `parse()` it models are pinned there too.
//
// The copied blocks are xterm.js's, under its MIT license. Its notice, verbatim from the installed
// package's LICENSE (`stream-filter.xterm.test.ts` checks it against that file):
//
// Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
// Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
// Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

// ---- BEGIN verbatim xterm 5.5.0 ----
export const enum ParserState {
  GROUND = 0,
  ESCAPE = 1,
  ESCAPE_INTERMEDIATE = 2,
  CSI_ENTRY = 3,
  CSI_PARAM = 4,
  CSI_INTERMEDIATE = 5,
  CSI_IGNORE = 6,
  SOS_PM_APC_STRING = 7,
  OSC_STRING = 8,
  DCS_ENTRY = 9,
  DCS_PARAM = 10,
  DCS_IGNORE = 11,
  DCS_INTERMEDIATE = 12,
  DCS_PASSTHROUGH = 13
}

export const enum ParserAction {
  IGNORE = 0,
  ERROR = 1,
  PRINT = 2,
  EXECUTE = 3,
  OSC_START = 4,
  OSC_PUT = 5,
  OSC_END = 6,
  CSI_DISPATCH = 7,
  PARAM = 8,
  COLLECT = 9,
  ESC_DISPATCH = 10,
  CLEAR = 11,
  DCS_HOOK = 12,
  DCS_PUT = 13,
  DCS_UNHOOK = 14
}

const enum TableAccess {
  TRANSITION_ACTION_SHIFT = 4,
  TRANSITION_STATE_MASK = 15,
  INDEX_STATE_SHIFT = 8
}

export class TransitionTable {
  public table: Uint8Array;

  constructor(length: number) {
    this.table = new Uint8Array(length);
  }

  /**
   * Set default transition.
   * @param action default action
   * @param next default next state
   */
  public setDefault(action: ParserAction, next: ParserState): void {
    this.table.fill(action << TableAccess.TRANSITION_ACTION_SHIFT | next);
  }

  /**
   * Add a transition to the transition table.
   * @param code input character code
   * @param state current parser state
   * @param action parser action to be done
   * @param next next parser state
   */
  public add(code: number, state: ParserState, action: ParserAction, next: ParserState): void {
    this.table[state << TableAccess.INDEX_STATE_SHIFT | code] = action << TableAccess.TRANSITION_ACTION_SHIFT | next;
  }

  /**
   * Add transitions for multiple input character codes.
   * @param codes input character code array
   * @param state current parser state
   * @param action parser action to be done
   * @param next next parser state
   */
  public addMany(codes: number[], state: ParserState, action: ParserAction, next: ParserState): void {
    for (let i = 0; i < codes.length; i++) {
      this.table[state << TableAccess.INDEX_STATE_SHIFT | codes[i]] = action << TableAccess.TRANSITION_ACTION_SHIFT | next;
    }
  }
}

const NON_ASCII_PRINTABLE = 0xA0;

export const VT500_TRANSITION_TABLE = (function (): TransitionTable {
  const table: TransitionTable = new TransitionTable(4095);

  // range macro for byte
  const BYTE_VALUES = 256;
  const blueprint = Array.apply(null, Array(BYTE_VALUES)).map((unused: any, i: number) => i);
  const r = (start: number, end: number): number[] => blueprint.slice(start, end);

  // Default definitions.
  const PRINTABLES = r(0x20, 0x7f); // 0x20 (SP) included, 0x7F (DEL) excluded
  const EXECUTABLES = r(0x00, 0x18);
  EXECUTABLES.push(0x19);
  EXECUTABLES.push.apply(EXECUTABLES, r(0x1c, 0x20));

  const states: number[] = r(ParserState.GROUND, ParserState.DCS_PASSTHROUGH + 1);
  let state: any;

  // set default transition
  table.setDefault(ParserAction.ERROR, ParserState.GROUND);
  // printables
  table.addMany(PRINTABLES, ParserState.GROUND, ParserAction.PRINT, ParserState.GROUND);
  // global anywhere rules
  for (state in states) {
    table.addMany([0x18, 0x1a, 0x99, 0x9a], state, ParserAction.EXECUTE, ParserState.GROUND);
    table.addMany(r(0x80, 0x90), state, ParserAction.EXECUTE, ParserState.GROUND);
    table.addMany(r(0x90, 0x98), state, ParserAction.EXECUTE, ParserState.GROUND);
    table.add(0x9c, state, ParserAction.IGNORE, ParserState.GROUND); // ST as terminator
    table.add(0x1b, state, ParserAction.CLEAR, ParserState.ESCAPE);  // ESC
    table.add(0x9d, state, ParserAction.OSC_START, ParserState.OSC_STRING);  // OSC
    table.addMany([0x98, 0x9e, 0x9f], state, ParserAction.IGNORE, ParserState.SOS_PM_APC_STRING);
    table.add(0x9b, state, ParserAction.CLEAR, ParserState.CSI_ENTRY);  // CSI
    table.add(0x90, state, ParserAction.CLEAR, ParserState.DCS_ENTRY);  // DCS
  }
  // rules for executables and 7f
  table.addMany(EXECUTABLES, ParserState.GROUND, ParserAction.EXECUTE, ParserState.GROUND);
  table.addMany(EXECUTABLES, ParserState.ESCAPE, ParserAction.EXECUTE, ParserState.ESCAPE);
  table.add(0x7f, ParserState.ESCAPE, ParserAction.IGNORE, ParserState.ESCAPE);
  table.addMany(EXECUTABLES, ParserState.OSC_STRING, ParserAction.IGNORE, ParserState.OSC_STRING);
  table.addMany(EXECUTABLES, ParserState.CSI_ENTRY, ParserAction.EXECUTE, ParserState.CSI_ENTRY);
  table.add(0x7f, ParserState.CSI_ENTRY, ParserAction.IGNORE, ParserState.CSI_ENTRY);
  table.addMany(EXECUTABLES, ParserState.CSI_PARAM, ParserAction.EXECUTE, ParserState.CSI_PARAM);
  table.add(0x7f, ParserState.CSI_PARAM, ParserAction.IGNORE, ParserState.CSI_PARAM);
  table.addMany(EXECUTABLES, ParserState.CSI_IGNORE, ParserAction.EXECUTE, ParserState.CSI_IGNORE);
  table.addMany(EXECUTABLES, ParserState.CSI_INTERMEDIATE, ParserAction.EXECUTE, ParserState.CSI_INTERMEDIATE);
  table.add(0x7f, ParserState.CSI_INTERMEDIATE, ParserAction.IGNORE, ParserState.CSI_INTERMEDIATE);
  table.addMany(EXECUTABLES, ParserState.ESCAPE_INTERMEDIATE, ParserAction.EXECUTE, ParserState.ESCAPE_INTERMEDIATE);
  table.add(0x7f, ParserState.ESCAPE_INTERMEDIATE, ParserAction.IGNORE, ParserState.ESCAPE_INTERMEDIATE);
  // osc
  table.add(0x5d, ParserState.ESCAPE, ParserAction.OSC_START, ParserState.OSC_STRING);
  table.addMany(PRINTABLES, ParserState.OSC_STRING, ParserAction.OSC_PUT, ParserState.OSC_STRING);
  table.add(0x7f, ParserState.OSC_STRING, ParserAction.OSC_PUT, ParserState.OSC_STRING);
  table.addMany([0x9c, 0x1b, 0x18, 0x1a, 0x07], ParserState.OSC_STRING, ParserAction.OSC_END, ParserState.GROUND);
  table.addMany(r(0x1c, 0x20), ParserState.OSC_STRING, ParserAction.IGNORE, ParserState.OSC_STRING);
  // sos/pm/apc does nothing
  table.addMany([0x58, 0x5e, 0x5f], ParserState.ESCAPE, ParserAction.IGNORE, ParserState.SOS_PM_APC_STRING);
  table.addMany(PRINTABLES, ParserState.SOS_PM_APC_STRING, ParserAction.IGNORE, ParserState.SOS_PM_APC_STRING);
  table.addMany(EXECUTABLES, ParserState.SOS_PM_APC_STRING, ParserAction.IGNORE, ParserState.SOS_PM_APC_STRING);
  table.add(0x9c, ParserState.SOS_PM_APC_STRING, ParserAction.IGNORE, ParserState.GROUND);
  table.add(0x7f, ParserState.SOS_PM_APC_STRING, ParserAction.IGNORE, ParserState.SOS_PM_APC_STRING);
  // csi entries
  table.add(0x5b, ParserState.ESCAPE, ParserAction.CLEAR, ParserState.CSI_ENTRY);
  table.addMany(r(0x40, 0x7f), ParserState.CSI_ENTRY, ParserAction.CSI_DISPATCH, ParserState.GROUND);
  table.addMany(r(0x30, 0x3c), ParserState.CSI_ENTRY, ParserAction.PARAM, ParserState.CSI_PARAM);
  table.addMany([0x3c, 0x3d, 0x3e, 0x3f], ParserState.CSI_ENTRY, ParserAction.COLLECT, ParserState.CSI_PARAM);
  table.addMany(r(0x30, 0x3c), ParserState.CSI_PARAM, ParserAction.PARAM, ParserState.CSI_PARAM);
  table.addMany(r(0x40, 0x7f), ParserState.CSI_PARAM, ParserAction.CSI_DISPATCH, ParserState.GROUND);
  table.addMany([0x3c, 0x3d, 0x3e, 0x3f], ParserState.CSI_PARAM, ParserAction.IGNORE, ParserState.CSI_IGNORE);
  table.addMany(r(0x20, 0x40), ParserState.CSI_IGNORE, ParserAction.IGNORE, ParserState.CSI_IGNORE);
  table.add(0x7f, ParserState.CSI_IGNORE, ParserAction.IGNORE, ParserState.CSI_IGNORE);
  table.addMany(r(0x40, 0x7f), ParserState.CSI_IGNORE, ParserAction.IGNORE, ParserState.GROUND);
  table.addMany(r(0x20, 0x30), ParserState.CSI_ENTRY, ParserAction.COLLECT, ParserState.CSI_INTERMEDIATE);
  table.addMany(r(0x20, 0x30), ParserState.CSI_INTERMEDIATE, ParserAction.COLLECT, ParserState.CSI_INTERMEDIATE);
  table.addMany(r(0x30, 0x40), ParserState.CSI_INTERMEDIATE, ParserAction.IGNORE, ParserState.CSI_IGNORE);
  table.addMany(r(0x40, 0x7f), ParserState.CSI_INTERMEDIATE, ParserAction.CSI_DISPATCH, ParserState.GROUND);
  table.addMany(r(0x20, 0x30), ParserState.CSI_PARAM, ParserAction.COLLECT, ParserState.CSI_INTERMEDIATE);
  // esc_intermediate
  table.addMany(r(0x20, 0x30), ParserState.ESCAPE, ParserAction.COLLECT, ParserState.ESCAPE_INTERMEDIATE);
  table.addMany(r(0x20, 0x30), ParserState.ESCAPE_INTERMEDIATE, ParserAction.COLLECT, ParserState.ESCAPE_INTERMEDIATE);
  table.addMany(r(0x30, 0x7f), ParserState.ESCAPE_INTERMEDIATE, ParserAction.ESC_DISPATCH, ParserState.GROUND);
  table.addMany(r(0x30, 0x50), ParserState.ESCAPE, ParserAction.ESC_DISPATCH, ParserState.GROUND);
  table.addMany(r(0x51, 0x58), ParserState.ESCAPE, ParserAction.ESC_DISPATCH, ParserState.GROUND);
  table.addMany([0x59, 0x5a, 0x5c], ParserState.ESCAPE, ParserAction.ESC_DISPATCH, ParserState.GROUND);
  table.addMany(r(0x60, 0x7f), ParserState.ESCAPE, ParserAction.ESC_DISPATCH, ParserState.GROUND);
  // dcs entry
  table.add(0x50, ParserState.ESCAPE, ParserAction.CLEAR, ParserState.DCS_ENTRY);
  table.addMany(EXECUTABLES, ParserState.DCS_ENTRY, ParserAction.IGNORE, ParserState.DCS_ENTRY);
  table.add(0x7f, ParserState.DCS_ENTRY, ParserAction.IGNORE, ParserState.DCS_ENTRY);
  table.addMany(r(0x1c, 0x20), ParserState.DCS_ENTRY, ParserAction.IGNORE, ParserState.DCS_ENTRY);
  table.addMany(r(0x20, 0x30), ParserState.DCS_ENTRY, ParserAction.COLLECT, ParserState.DCS_INTERMEDIATE);
  table.addMany(r(0x30, 0x3c), ParserState.DCS_ENTRY, ParserAction.PARAM, ParserState.DCS_PARAM);
  table.addMany([0x3c, 0x3d, 0x3e, 0x3f], ParserState.DCS_ENTRY, ParserAction.COLLECT, ParserState.DCS_PARAM);
  table.addMany(EXECUTABLES, ParserState.DCS_IGNORE, ParserAction.IGNORE, ParserState.DCS_IGNORE);
  table.addMany(r(0x20, 0x80), ParserState.DCS_IGNORE, ParserAction.IGNORE, ParserState.DCS_IGNORE);
  table.addMany(r(0x1c, 0x20), ParserState.DCS_IGNORE, ParserAction.IGNORE, ParserState.DCS_IGNORE);
  table.addMany(EXECUTABLES, ParserState.DCS_PARAM, ParserAction.IGNORE, ParserState.DCS_PARAM);
  table.add(0x7f, ParserState.DCS_PARAM, ParserAction.IGNORE, ParserState.DCS_PARAM);
  table.addMany(r(0x1c, 0x20), ParserState.DCS_PARAM, ParserAction.IGNORE, ParserState.DCS_PARAM);
  table.addMany(r(0x30, 0x3c), ParserState.DCS_PARAM, ParserAction.PARAM, ParserState.DCS_PARAM);
  table.addMany([0x3c, 0x3d, 0x3e, 0x3f], ParserState.DCS_PARAM, ParserAction.IGNORE, ParserState.DCS_IGNORE);
  table.addMany(r(0x20, 0x30), ParserState.DCS_PARAM, ParserAction.COLLECT, ParserState.DCS_INTERMEDIATE);
  table.addMany(EXECUTABLES, ParserState.DCS_INTERMEDIATE, ParserAction.IGNORE, ParserState.DCS_INTERMEDIATE);
  table.add(0x7f, ParserState.DCS_INTERMEDIATE, ParserAction.IGNORE, ParserState.DCS_INTERMEDIATE);
  table.addMany(r(0x1c, 0x20), ParserState.DCS_INTERMEDIATE, ParserAction.IGNORE, ParserState.DCS_INTERMEDIATE);
  table.addMany(r(0x20, 0x30), ParserState.DCS_INTERMEDIATE, ParserAction.COLLECT, ParserState.DCS_INTERMEDIATE);
  table.addMany(r(0x30, 0x40), ParserState.DCS_INTERMEDIATE, ParserAction.IGNORE, ParserState.DCS_IGNORE);
  table.addMany(r(0x40, 0x7f), ParserState.DCS_INTERMEDIATE, ParserAction.DCS_HOOK, ParserState.DCS_PASSTHROUGH);
  table.addMany(r(0x40, 0x7f), ParserState.DCS_PARAM, ParserAction.DCS_HOOK, ParserState.DCS_PASSTHROUGH);
  table.addMany(r(0x40, 0x7f), ParserState.DCS_ENTRY, ParserAction.DCS_HOOK, ParserState.DCS_PASSTHROUGH);
  table.addMany(EXECUTABLES, ParserState.DCS_PASSTHROUGH, ParserAction.DCS_PUT, ParserState.DCS_PASSTHROUGH);
  table.addMany(PRINTABLES, ParserState.DCS_PASSTHROUGH, ParserAction.DCS_PUT, ParserState.DCS_PASSTHROUGH);
  table.add(0x7f, ParserState.DCS_PASSTHROUGH, ParserAction.IGNORE, ParserState.DCS_PASSTHROUGH);
  table.addMany([0x1b, 0x9c, 0x18, 0x1a], ParserState.DCS_PASSTHROUGH, ParserAction.DCS_UNHOOK, ParserState.GROUND);
  // special handling of unicode chars
  table.add(NON_ASCII_PRINTABLE, ParserState.GROUND, ParserAction.PRINT, ParserState.GROUND);
  table.add(NON_ASCII_PRINTABLE, ParserState.OSC_STRING, ParserAction.OSC_PUT, ParserState.OSC_STRING);
  table.add(NON_ASCII_PRINTABLE, ParserState.CSI_IGNORE, ParserAction.IGNORE, ParserState.CSI_IGNORE);
  table.add(NON_ASCII_PRINTABLE, ParserState.DCS_IGNORE, ParserAction.IGNORE, ParserState.DCS_IGNORE);
  table.add(NON_ASCII_PRINTABLE, ParserState.DCS_PASSTHROUGH, ParserAction.DCS_PUT, ParserState.DCS_PASSTHROUGH);
  return table;
})();
// ---- END verbatim xterm 5.5.0 ----

const STRING_STATES = new Set<number>([
  ParserState.SOS_PM_APC_STRING,
  ParserState.OSC_STRING,
  ParserState.DCS_ENTRY,
  ParserState.DCS_PARAM,
  ParserState.DCS_IGNORE,
  ParserState.DCS_INTERMEDIATE,
  ParserState.DCS_PASSTHROUGH
])

// One code through `EscapeSequenceParser.parse()`'s state walk, without its handlers. Two facts
// about `parse()` make a one-code-at-a-time walk of the table exact: its read-ahead loops (PRINT,
// PARAM, OSC_PUT, DCS_PUT) only take codes whose table entry keeps the state they are in, and an
// OSC or DCS ended by ESC goes to ESCAPE although the table says GROUND
// (`transition |= ParserState.ESCAPE`). An ERROR (a non-ASCII code in SOS/PM/APC or a DCS header)
// goes to GROUND with the default error handler, as the table says. The lines of parse() this
// stands for are pinned in `stream-filter.xterm.test.ts`.
function step(state: number, code: number): number {
  let transition = VT500_TRANSITION_TABLE.table[state << TableAccess.INDEX_STATE_SHIFT | (code < 0xa0 ? code : NON_ASCII_PRINTABLE)]
  const action = transition >> TableAccess.TRANSITION_ACTION_SHIFT
  if ((action === ParserAction.OSC_END || action === ParserAction.DCS_UNHOOK) && code === 0x1b) {
    transition |= ParserState.ESCAPE
  }
  return transition & TableAccess.TRANSITION_STATE_MASK
}

/**
 * For each code point of a stream read from GROUND, whether xterm consumes it INSIDE a string
 * sequence (OSC, DCS, SOS, PM, APC): in a string state before it and still in one after it.
 */
export function xtermStringPayload(codePoints: readonly number[]): boolean[] {
  let state: number = ParserState.GROUND
  return codePoints.map((code) => {
    const next = step(state, code)
    const inside = STRING_STATES.has(state) && STRING_STATES.has(next)
    state = next
    return inside
  })
}

/** Whether xterm, reading these code points from GROUND, ever enters a string sequence. */
export function xtermEntersString(codePoints: readonly number[]): boolean {
  let state: number = ParserState.GROUND
  for (const code of codePoints) {
    state = step(state, code)
    if (STRING_STATES.has(state)) return true
  }
  return false
}
