import React, { useState, useCallback, useEffect } from "react";
import { AppWrapper } from "./AppWrapper";
import { IconToggle } from "./component/IconToggle";
import { Codearea } from "./component/Codearea";
import { ErrorMessage } from "./component/ErrorMessage";
import { LoaderPane } from "./component/LoaderPane";
import { Char } from "./component/Char";
import { Box, Flex } from "./layout/Layout";
import { Sidebar, SidebarInfo, SidebarShare, Footer } from "./Sidebars";
import styled from "styled-components";

import { PitchRuler, useRulerState } from "./PitchRuler";
import type { RulerState } from "./PitchRuler";

import { XenpaperGrammarParser } from "./data/grammar";
import type { XenpaperAST, SetterGroupType } from "./data/grammar";

import { grammarToChars } from "./data/grammar-to-chars";
import { processGrammar } from "./data/process-grammar";
import type { InitialRulerState } from "./data/process-grammar";
import type { MoscScore } from "@xenpaper/mosc";
import type { HighlightColor, CharData } from "./data/grammar-to-chars";

import { useHash, hashify } from "./hooks/useHash";
import { useWindowLoaded } from "./hooks/useWindowLoaded";

import { useDendriform, useInput } from "dendriform";
import type { Dendriform } from "dendriform";
import { setAutoFreeze, enableMapSet } from "immer";
setAutoFreeze(false); // sadly I am relying on mutations within the xenpaper AST because who cares
enableMapSet();

import { scoreToMs } from "@xenpaper/mosc";
import type { SoundEngine } from "@xenpaper/mosc";
import { SoundEngineTonejs } from "@xenpaper/sound-engine-tonejs";

import { Helmet } from "react-helmet";

// This should be enough
// import { WebMidi } from "webmidi";
// import { MidiOut, Note } from "xen-midi";

/* Copy & paste because I don't know what yarn/lerna is complaining about */
import {Output, WebMidi} from 'webmidi';

// I think this is right. The original is from xen-dev-utils.
function ftom(f: number) {
    const m = Math.log(f/440)/Math.log(2)*12 + 69;
    return [Math.round(m), (m - Math.round(m)) * 100];
}

/**
 * Pitch bend range measured in semitones (+-).
 */
export const BEND_RANGE_IN_SEMITONES = 2;

// Large but finite number to signify voices that are off
const EXPIRED = 10000;

// Cents offset tolerance for channel reuse.
const EPSILON = 1e-6;

/**
 * Abstraction for a pitch-bent midi channel.
 * Polyphonic in pure octaves and 12edo in general.
 */
type Voice = {
  age: number;
  channel: number;
  centsOffset: number;
};

/**
 * Free-pitch MIDI note to be played at a later time.
 */
export type Note = {
  /** Frequency in Hertz (Hz) */
  frequency: number;
  /** Attack velocity from 0 to 127. */
  rawAttack?: number;
  /** Release velocity from 0 to 127. */
  rawRelease?: number;
  /** Note-on time in milliseconds (ms) as measured by `WebMidi.time`.
   * If time is a string prefixed with "+" and followed by a number, the message will be delayed by that many milliseconds.
   */
  time: DOMHighResTimeStamp | string;
  /** Note duration in milliseconds (ms). */
  duration: DOMHighResTimeStamp;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function emptyNoteOff(rawRelease?: number, time?: DOMHighResTimeStamp) {}

/**
 * Returned by MIDI note on. Turns the note off when called.
 */
export type NoteOff = typeof emptyNoteOff;

/**
 * Wrapper for a webmidi.js output.
 * Uses multiple channels to achieve polyphonic microtuning.
 */

export class MidiOut {
  output: Output | null;
  channels: Set<number>;
  log: (msg: string) => void;
  private voices: Voice[];
  private lastEventTime: DOMHighResTimeStamp;

  /**
   * Constuct a new wrapper for a webmidi.js output.
   * @param output Output device or `null` if you need a dummy out.
   * @param channels Channels to use for sending pitch bent MIDI notes. Number of channels determines maximum microtonal polyphony.
   * @param log Logging function.
   */
  constructor(
    output: Output | null,
    channels: Set<number>,
    log?: (msg: string) => void
  ) {
    this.output = output;
    this.channels = channels;
    if (log === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      this.log = msg => {};
    } else {
      this.log = log;
    }

    this.voices = [];
    this.channels.forEach(channel => {
      this.voices.push({
        age: EXPIRED,
        centsOffset: NaN,
        channel,
      });
    });
    this.lastEventTime = WebMidi.time;

    this.sendPitchBendRange();
  }

  private sendPitchBendRange() {
    if (this.output !== null) {
      this.channels.forEach(channel => {
        this.output!.channels[channel].sendPitchBendRange(
          BEND_RANGE_IN_SEMITONES,
          0
        );
      });
    }
  }

  /**
   * Select a voice that's using a cents offset combatible channel or the oldest voice if nothing can be re-used.
   * @param centsOffset Cents offset (pitch-bend) from 12edo.
   * @returns A voice for the next note-on event.
   */
  private selectVoice(centsOffset: number) {
    // Age signifies how many note ons have occured after voice intialization
    this.voices.forEach(voice => voice.age++);

    // Re-use a channel that already has the correct pitch bend
    for (let i = 0; i < this.voices.length; ++i) {
      if (Math.abs(this.voices[i].centsOffset - centsOffset) < EPSILON) {
        this.log(`Re-using channel ${this.voices[i].channel}`);
        this.voices[i].age = 0;
        return this.voices[i];
      }
    }

    // Nothing re-usable found. Use the oldest voice.
    let oldestVoice = this.voices[0];
    this.voices.forEach(voice => {
      if (voice.age > oldestVoice.age) {
        oldestVoice = voice;
      }
    });
    oldestVoice.age = 0;
    oldestVoice.centsOffset = centsOffset;
    return oldestVoice;
  }

  /**
   * Send a note-on event and pitch-bend to the output device in one of the available channels.
   * @param frequency Frequency of the note in Hertz (Hz).
   * @param rawAttack Attack velocity of the note from 0 to 127.
   * @returns A callback for sending a corresponding note off in the correct channel.
   */
  sendNoteOn(
    frequency: number,
    rawAttack?: number,
    time?: DOMHighResTimeStamp
  ): NoteOff {
    if (time === undefined) {
      time = WebMidi.time;
    }
    if (time < this.lastEventTime) {
      throw new Error(
        `Events must be triggered in causal order: ${time} < ${this.lastEventTime} (note on)`
      );
    }
    this.lastEventTime = time;

    if (this.output === null) {
      return emptyNoteOff;
    }
    if (!this.channels.size) {
      return emptyNoteOff;
    }
    const [noteNumber, centsOffset] = ftom(frequency);
    if (noteNumber < 0 || noteNumber >= 128) {
      return emptyNoteOff;
    }
    const voice = this.selectVoice(centsOffset);
    this.log(
      `Sending note on ${noteNumber} at velocity ${
        (rawAttack || 64) / 127
      } on channel ${
        voice.channel
      } with bend ${centsOffset} resulting from frequency ${frequency}`
    );
    const bendRange = BEND_RANGE_IN_SEMITONES * 100;
    this.output.channels[voice.channel].sendPitchBend(centsOffset / bendRange);
    this.output.channels[voice.channel].sendNoteOn(noteNumber, {
      rawAttack,
      time,
    });

    const noteOff = (rawRelease?: number, time?: DOMHighResTimeStamp) => {
      if (time === undefined) {
        time = WebMidi.time;
      }
      if (time < this.lastEventTime) {
        throw new Error(
          `Events must be triggered in causal order: ${time} < ${this.lastEventTime} (note off)`
        );
      }
      this.lastEventTime = time;

      this.log(
        `Sending note off ${noteNumber} at velocity ${
          (rawRelease || 64) / 127
        } on channel ${voice.channel}`
      );
      voice.age = EXPIRED;
      this.output!.channels[voice.channel].sendNoteOff(noteNumber, {
        rawRelease,
        time,
      });
    };
    return noteOff;
  }

  /**
   * Schedule a series of notes to be played at a later time.
   * Please note that this reserves the channels until all notes have finished playing.
   * @param notes Notes to be played.
   */
  playNotes(notes: Note[]) {
    // Break notes into events.
    const now = WebMidi.time;
    const events = [];
    for (const note of notes) {
      let time: number;
      if (typeof note.time === 'string') {
        if (note.time.startsWith('+')) {
          time = now + parseFloat(note.time.slice(1));
        } else {
          time = parseFloat(note.time);
        }
      } else {
        time = note.time;
      }
      const off = {
        type: 'off' as const,
        rawRelease: note.rawRelease,
        time: time + note.duration,
        callback: emptyNoteOff,
      };
      events.push({
        type: 'on' as const,
        frequency: note.frequency,
        rawAttack: note.rawAttack,
        time,
        off,
      });
      events.push(off);
    }

    // Sort events in causal order.
    events.sort((a, b) => a.time - b.time);

    // Trigger events in causal order.
    for (const event of events) {
      if (event.type === 'on') {
        event.off.callback = this.sendNoteOn(
          event.frequency,
          event.rawAttack,
          event.time
        );
      } else if (event.type === 'off') {
        event.callback(event.rawRelease, event.time);
      }
    }
  }

  /**
   * Clear scheduled notes that have not yet been played.
   * Will start working once the Chrome bug is fixed: https://bugs.chromium.org/p/chromium/issues/detail?id=471798
   */
  clear() {
    if (this.output !== null) {
      this.output.clear();
      this.output.sendAllNotesOff();
    }
    this.lastEventTime = WebMidi.time;
  }
}

/** End of copy & paste */



//
// sound engine instance
//

const soundEngine: SoundEngine = new SoundEngineTonejs();

//
// xenpaper ast parsing
//

type Parsed = {
    parsed?: XenpaperAST;
    chars?: CharData[];
    score?: MoscScore;
    initialRulerState?: InitialRulerState;
    error: string;
};

const parse = (unparsed: string): Parsed => {
    try {
        const parsed = XenpaperGrammarParser(unparsed);
        const { score, initialRulerState } = processGrammar(parsed);
        const chars = grammarToChars(parsed);

        if (score) {
            const scoreMs = scoreToMs(score);
            soundEngine.setScore(scoreMs);

            const midiScore: Note[] = [];
            for (const event of scoreMs.sequence) {
                if (event.type === "NOTE_MS") {
                    midiScore.push({
                        frequency: event.hz,
                        time: `+${event.ms}`,
                        duration: event.msEnd - event.ms
                    });
                }
            }
            // State schmate
            (window as any).midiScore = midiScore;
        }

        return {
            parsed,
            chars,
            score,
            initialRulerState,
            error: "",
        };
    } catch (e) {
        console.log("!", e);
        const matched = e.message.match(/Unexpected token at (\d+):(\d+)/);

        const lineNumber: number = matched ? Number(matched[1]) - 1 : -1;
        const colNumber: number = matched ? Number(matched[2]) - 1 : -1;

        const chars: CharData[] = [];
        let lineCount = 0;
        let colCount = 0;
        let error;
        let errorAt;

        for (let i = 0; i < unparsed.length + 40; i++) {
            if (lineCount === lineNumber && colCount === colNumber) {
                errorAt = i;
            }
            if (unparsed[i] === "\n") {
                lineCount++;
                colCount = 0;
            } else {
                colCount++;
            }
        }

        if (typeof errorAt === "number") {
            error =
                unparsed[errorAt] !== undefined
                    ? e.message.replace(
                          "Unexpected token ",
                          `Unexpected token "${unparsed[errorAt]}" `
                      )
                    : e.message;

            chars[errorAt] = {
                color: "error",
            };
        } else {
            error = e.message;
        }

        return {
            parsed: undefined,
            chars,
            score: undefined,
            initialRulerState: undefined,
            error,
        };
    }
};

const getMsAtLine = (
    tune: string,
    chars: CharData[] | undefined,
    line: number
): number => {
    if (line === 0) {
        return 0;
    }
    let ms = 0;
    let counted = 0;
    const tuneSplit = tune.split("");
    for (let i = 0; i < tuneSplit.length; i++) {
        const chr = tuneSplit[i];
        const ch = chars?.[i];
        const [, end] = ch?.playTime ?? [];
        if (end !== undefined) {
            ms = end;
        }
        if (chr === "\n") {
            counted++;
            if (counted === line) {
                return ms;
            }
        }
    }
    return 0;
};

//
// icons
//

const PLAY_PATHS = {
    paused: ["M 0 0 L 12 6 L 0 12 Z"],
    playing: ["M 0 0 L 4 0 L 4 12 L 0 12 Z", "M 8 0 L 12 0 L 12 12 L 8 12 Z"],
    // stopped: ['M 0 0 L 12 0 L 12 12 L 0 12 Z'],
};

//
// application component with loader
//

export function Xenpaper(): React.ReactElement {
    const loaded = useWindowLoaded();

    return (
        <AppWrapper>
            <LoaderPane height="100vh" loaded={loaded}>
                <XenpaperApp loaded={loaded} />
            </LoaderPane>
        </AppWrapper>
    );
}

//
// application component
//

export type SidebarState = "info" | "share" | "ruler" | "none";

// type RealtimeState = {
//     on: boolean;
//     activeNotes: number[];
// };

export type TuneForm = {
    tune: string;
    embed: boolean;
    hash: string;
    url: string;
    urlEmbed: string;
};

type Props = {
    loaded: boolean;
};

export function XenpaperApp(props: Props): React.ReactElement {
    const { loaded } = props;

    //
    // dendriforms with application state
    //

    const [hash, setHash] = useHash();

    const tuneForm = useDendriform<TuneForm>(
        () => {
            let embed = false;
            let tune = hash;
            if (tune.startsWith("embed:")) {
                embed = true;
                tune = tune.substr(6);
            }
            return {
                tune,
                embed,
                hash: "",
                url: "",
                urlEmbed: "",
            };
        },
        { history: 300 }
    );

    tuneForm.useDerive((newValue) => {
        let hash = newValue.tune;
        const hashified = hashify(hash);

        if (newValue.embed) {
            hash = `embed:${hash}`;
        }

        const url = `https://xenpaper.com/#${hashified}`;
        const urlEmbed = `https://xenpaper.com/#embed:${hashified}`;

        tuneForm.branch("hash").set(hash);
        tuneForm.branch("url").set(url);
        tuneForm.branch("urlEmbed").set(urlEmbed);
    });

    tuneForm.branch("hash").useChange((hash) => {
        setHash(hash);
    });

    const parsedForm = useDendriform<Parsed>(() => parse(tuneForm.value.tune));

    tuneForm.useDerive((value) => {
        parsedForm.set(parse(value.tune));
    });

    //
    // state syncing between sound engine and react
    //

    const playing = useDendriform<boolean>(false);
    const selectedLine = useDendriform<number>(0);
    selectedLine.useChange((line) => {
        soundEngine.setLoopStart(
            getMsAtLine(tuneForm.value.tune, parsedForm.value.chars, line)
        );
    });

    // Herp derp, I'm in your MIDI and have no idea how to use React.
    useEffect(() => {
        async function init() {
            await WebMidi.enable();

            let query = "Please select output device:";

            for (let i = 0; i < WebMidi.outputs.length; ++i) {
                query += `\n${i}: ${WebMidi.outputs[i].name}`;
            }

            const selection = parseInt(window.prompt(query) || "0");

            // Only one of these outputs should be selectable by the user and the channels should be configurable too.
            const channels = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16]);
            // State management, what state management?
            (window as any).midiOut = new MidiOut(WebMidi.outputs[selection], channels);
        }
        init();
    });

    useEffect(() => {
        return soundEngine.onEnd(() => {
            playing.set(false);
        });
    }, []);

    const looping = useDendriform<boolean>(false);

    //
    // ruler state
    //

    const rulerState = useRulerState(parsedForm.value.initialRulerState);

    useEffect(() => {
        return soundEngine.onNote((note, on) => {
            const id = `${note.ms}-${note.hz}`;
            rulerState.set((draft) => {
                if (on) {
                    draft.notesActive.set(id, note);
                    draft.notes.set(id, note);
                } else {
                    draft.notesActive.delete(id);
                }
            });
        });
    }, []);

    parsedForm.branch("initialRulerState").useChange((initialRulerState) => {
        rulerState.set((draft) => {
            draft.rootHz = initialRulerState?.rootHz;
            draft.octaveSize = initialRulerState?.octaveSize;
            draft.plots = initialRulerState?.plots;
            if (draft.colourMode.startsWith("proxplot")) {
                const index = Number(draft.colourMode.replace("proxplot", ""));
                if (index >= (draft.plots ?? []).length) {
                    draft.colourMode = "gradient";
                }
            }
        });
    });

    //
    // sound engine callbacks
    //

    const handleSetPlayback = useCallback((play: boolean) => {
        if (parsedForm.value.error) return;

        soundEngine.gotoMs(
            getMsAtLine(
                tuneForm.value.tune,
                parsedForm.value.chars,
                selectedLine.value
            )
        );

        playing.set(play);

        if (play) {
            soundEngine.play();
            rulerState.set((draft) => {
                draft.notes.clear();
            });
            ((window as any).midiOut as MidiOut).playNotes((window as any).midiScore as Note[]);
        } else {
            soundEngine.pause();
            // Unfortunately the MIDI API in the browser doesn't actually let you cancel scheduled notes.
            (window as any).midiOut.clear();
        }
    }, []);

    const handleTogglePlayback = useCallback((state: string) => {
        handleSetPlayback(state === "paused");
    }, []);

    const handleToggleLoop = useCallback(() => {
        const newValue = !looping.value;
        looping.set(newValue);
        soundEngine.setLoopActive(newValue);
    }, []);

    //
    // special key combos
    //

    useEffect(() => {
        const callback = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.keyCode === 13) {
                handleSetPlayback(playing.value);
            }
            if ((event.ctrlKey || event.metaKey) && event.keyCode === 90) {
                event.preventDefault();
                if (event.shiftKey) {
                    tuneForm.redo();
                } else {
                    tuneForm.undo();
                }
            }
        };

        document.addEventListener("keydown", callback);
        return () => document.removeEventListener("keydown", callback);
    }, []);

    //
    // sidebar state
    //

    const [sidebarState, setSidebar] = useState<SidebarState>(() => {
        return parsedForm.value?.initialRulerState?.lowHz ? "ruler" : "info";
    });

    const toggleSidebarInfo = useCallback(() => {
        setSidebar((s) => (s !== "info" ? "info" : "none"));
    }, []);

    const toggleSidebarShare = useCallback(() => {
        setSidebar((s) => (s !== "share" ? "share" : "none"));
    }, []);

    const toggleSidebarRuler = useCallback(() => {
        setSidebar((s) => (s !== "ruler" ? "ruler" : "none"));
    }, []);

    const onSetTune = useCallback(async (tune: string): Promise<void> => {
        tuneForm.branch("tune").set(tune);
        await soundEngine.gotoMs(0);
        handleSetPlayback(true);
    }, []);

    const codepaneContainerProps = {};

    //
    // elements
    //

    const playPause = playing.render(
        (form) => {
            return (
                <IconToggle
                    state={form.useValue() ? "playing" : "paused"}
                    paths={PLAY_PATHS}
                    onClick={handleTogglePlayback}
                    loaded={loaded}
                    hoverBackground
                    large={!tuneForm.branch("embed").useValue()}
                />
            );
        },
        [loaded]
    );

    const undoRedo = tuneForm.render((form) => {
        const { canUndo, canRedo } = form.useHistory();
        return (
            <>
                <SideButton onClick={form.undo} disabled={!canUndo}>
                    Undo
                </SideButton>
                <SideButton onClick={form.redo} disabled={!canRedo}>
                    Redo
                </SideButton>
            </>
        );
    });

    const loop = looping.render((looping) => {
        return (
            <SideButton onClick={handleToggleLoop} active={looping.useValue()}>
                Loop
            </SideButton>
        );
    });

    const sidebarToggles = (
        <>
            <SideButton onClick={toggleSidebarInfo}>Info</SideButton>
            <SideButton onClick={toggleSidebarShare}>Share</SideButton>
            <SideButton onClick={toggleSidebarRuler}>Ruler</SideButton>
        </>
    );

    const sidebar = (
        <>
            {sidebarState === "info" && (
                <SidebarInfo onSetTune={onSetTune} setSidebar={setSidebar} />
            )}
            {sidebarState === "share" &&
                tuneForm.render((form) => {
                    const url = form.branch("url").useValue();
                    const urlEmbed = form.branch("urlEmbed").useValue();
                    return (
                        <SidebarShare
                            setSidebar={setSidebar}
                            url={url}
                            urlEmbed={urlEmbed}
                        />
                    );
                })}
            {sidebarState === "ruler" && (
                <Sidebar
                    setSidebar={setSidebar}
                    title="Pitch ruler"
                    desc="Click and drag to pan, use mousewheel to zoom."
                    wide
                >
                    <PitchRuler rulerState={rulerState} />
                </Sidebar>
            )}
        </>
    );

    const code = (
        <CodePanel
            tuneForm={tuneForm}
            parsedForm={parsedForm}
            selectedLine={selectedLine}
        />
    );

    const htmlTitle = <SetHtmlTitle tuneForm={tuneForm} />;

    const openOnXenpaper = tuneForm.render("url", (form) => (
        <EditOnXenpaperButton href={form.useValue()} target="_blank">
            Edit on Xenpaper
        </EditOnXenpaperButton>
    ));

    const embedLayout = tuneForm.branch("embed").useValue();

    if (embedLayout) {
        return (
            <EmbedLayout
                playPause={playPause}
                loop={loop}
                code={code}
                openOnXenpaper={openOnXenpaper}
                htmlTitle={htmlTitle}
                codepaneContainerProps={codepaneContainerProps}
            />
        );
    }

    return (
        <NormalLayout
            playPause={playPause}
            undoRedo={undoRedo}
            loop={loop}
            code={code}
            htmlTitle={htmlTitle}
            sidebarToggles={sidebarToggles}
            sidebar={sidebar}
            codepaneContainerProps={codepaneContainerProps}
        />
    );
}

//
// layouts
//

type NormalLayoutProps = {
    playPause: React.ReactNode;
    undoRedo: React.ReactNode;
    loop: React.ReactNode;
    code: React.ReactNode;
    htmlTitle: React.ReactNode;
    sidebarToggles: React.ReactNode;
    sidebar: React.ReactNode;
    codepaneContainerProps: { [prop: string]: unknown };
};

function NormalLayout(props: NormalLayoutProps): React.ReactElement {
    const {
        playPause,
        undoRedo,
        loop,
        code,
        htmlTitle,
        sidebarToggles,
        sidebar,
        codepaneContainerProps,
    } = props;

    return (
        <Flex height="100vh" flexDirection="column">
            <Flex
                display={["block", "flex"]}
                flexGrow="1"
                flexShrink="1"
                minHeight="0"
                position="relative"
            >
                {/* toolbar on mobile */}
                <Toolbar
                    display={["flex", "none"]}
                    position="fixed"
                    top={0}
                    width="100%"
                >
                    {playPause}
                    {undoRedo}
                    {loop}
                </Toolbar>
                {/* toolbar on desktop */}
                <Toolbar display={["none", "block"]} mt={4} px={2} pt="12px">
                    <Box mb={3}>{playPause}</Box>
                    {undoRedo}
                    {loop}
                    <Hr my={2} />
                    {sidebarToggles}
                </Toolbar>
                {/* codepane */}
                <Box
                    flexGrow="1"
                    flexShrink="1"
                    pl={[0, 3]}
                    overflow="auto"
                    mt={3}
                    pt={["24px", 3]}
                    {...codepaneContainerProps}
                >
                    {code}
                </Box>
                {/* horizontal rule on mobile */}
                <Hr display={["block", "none"]} mt={4} />
                {/* more tool buttons on mobile */}
                <Box display={["flex", "none"]}>{sidebarToggles}</Box>
                {/* sidebars */}
                {sidebar}
            </Flex>
            <Footer display={["none", "none", "block"]} />
            {htmlTitle}
        </Flex>
    );
}

type EmbedLayoutProps = {
    playPause: React.ReactNode;
    loop: React.ReactNode;
    code: React.ReactNode;
    openOnXenpaper: React.ReactNode;
    htmlTitle: React.ReactNode;
    codepaneContainerProps: { [prop: string]: unknown };
};

function EmbedLayout(props: EmbedLayoutProps): React.ReactElement {
    const {
        playPause,
        loop,
        code,
        htmlTitle,
        openOnXenpaper,
        codepaneContainerProps,
    } = props;

    return (
        <Flex height="100vh" flexDirection="column">
            <Flex flexGrow="1" flexShrink="1" minHeight="0" position="relative">
                <Toolbar display="flex" position="fixed" top={0} width="100%">
                    {playPause}
                    {loop}
                    {openOnXenpaper}
                </Toolbar>
                <Box
                    flexGrow="1"
                    flexShrink="1"
                    overflow="auto"
                    mt={3}
                    pt="24px"
                    {...codepaneContainerProps}
                >
                    {code}
                </Box>
            </Flex>
            {htmlTitle}
        </Flex>
    );
}

//
// codepanel
//

type CodePanelProps = {
    tuneForm: Dendriform<TuneForm>;
    parsedForm: Dendriform<Parsed>;
    selectedLine: Dendriform<number>;
};

function CodePanel(props: CodePanelProps): React.ReactElement {
    return props.tuneForm.render((form) => {
        const embed = form.branch("embed").useValue();

        // get dendriform state values
        const { chars, error } = props.parsedForm.useValue();

        // use value with a 200ms debounce for perf reasons
        // this debounce does cause the code value to progress forward
        // without the calculated syntax highlighting
        // so colours will be momentarily skew-whiff
        // but thats better than parsing the xenpaper AST at every keystroke
        const inputProps = useInput(form.branch("tune"), 200);
        const tuneChars: string[] = inputProps.value.split("");
        const charDataArray: (CharData | undefined)[] = tuneChars.map(
            (chr, index) => chars?.[index]
        );

        const hasPlayStartButtons = tuneChars.some((ch) => ch === "\n");
        let playStartLine = 0;

        const charElements: React.ReactNode[] = [];

        const createPlayStart = () => {
            charElements.push(
                <PlayStart
                    key={`playstart${playStartLine}`}
                    line={playStartLine++}
                    selectedLine={props.selectedLine}
                />
            );
        };

        if (hasPlayStartButtons) {
            createPlayStart();
        }
        charDataArray.forEach((charData, index) => {
            const ch = tuneChars[index];

            charElements.push(
                <Char
                    key={index}
                    ch={ch}
                    charData={charData}
                    soundEngine={soundEngine}
                />
            );

            if (ch === "\n") {
                createPlayStart();
            }
        });

        // stop event propagation here so we can detect clicks outside of this element in isolation
        const stopPropagation = (e: Event) => e.stopPropagation();

        return (
            <Box onClick={stopPropagation}>
                <Codearea
                    {...inputProps}
                    charElements={charElements}
                    freeze={embed}
                />
                {error && (
                    <Box>
                        <ErrorMessage>Error: {error}</ErrorMessage>
                    </Box>
                )}
            </Box>
        );
    });
}

//
// html title
//

type SetHtmlTitleProps = {
    tuneForm: Dendriform<TuneForm>;
};

function SetHtmlTitle(props: SetHtmlTitleProps): React.ReactElement {
    return props.tuneForm.render("tune", (form) => {
        const tune = form.useValue();
        // set title based on code in text area
        const titleLimit = 20;
        const title =
            tune.length === 0
                ? "Xenpaper"
                : tune.length > titleLimit
                ? `Xenpaper: ${tune.slice(0, titleLimit)}...`
                : `Xenpaper: ${tune}`;

        return (
            <Helmet>
                <title>{title}</title>
                <meta property="og:title" content={title} />
            </Helmet>
        );
    });
}

//
//
// styled components
//

const Toolbar = styled(Box)`
    background-color: ${(props) => props.theme.colors.background.normal};
    z-index: 4;
`;

const Hr = styled(Box)`
    border-top: 1px ${(props) => props.theme.colors.background.light} solid;
`;

type SideButtonProps = {
    active?: boolean;
    multiline?: boolean;
};

const SideButton = styled.button<SideButtonProps>`
    border: none;
    display: block;
    padding: ${(props) => (props.multiline ? ".5rem" : "1rem .5rem")};
    cursor: ${(props) => (props.disabled ? "default" : "pointer")};
    background-color: ${(props) =>
        props.active
            ? props.theme.colors.text.placeholder
            : props.theme.colors.background.normal};
    color: ${(props) =>
        props.disabled
            ? props.theme.colors.highlights.unknown
            : props.active
            ? props.theme.colors.background.normal
            : props.theme.colors.highlights.comment};
    position: relative;
    outline: none;
    font-family: ${(props) => props.theme.fonts.mono};
    font-size: ${(props) => (props.multiline ? "0.8rem" : "0.9rem")};
    text-align: center;
    width: auto;
    text-transform: uppercase;
    border-left: 3px solid transparent;
    ${(props) => props.multiline && `line-height: 1em;`}

    ${(props) =>
        !props.active
            ? `&:hover, &:focus, &:active {
        background-color: ${props.theme.colors.background.light};
    }`
            : ``}

    @media all and (min-width: ${(props) => props.theme.widths.sm}) {
        padding: 0.5rem;
        font-size: ${(props) => (props.multiline ? "0.9rem" : "1.1rem")};
        width: 5rem;
    }
`;

type EditOnXenpaperButtonProps = {
    multiline?: boolean;
};

const EditOnXenpaperButton = styled.a<EditOnXenpaperButtonProps>`
    border: none;
    height: 3rem;
    line-height: 1rem;
    display: block;
    padding: ${(props) => (props.multiline ? ".5rem" : "1rem .5rem")};
    cursor: pointer;
    background-color: ${(props) => props.theme.colors.background.normal};
    color: ${(props) => props.theme.colors.highlights.comment};
    position: relative;
    outline: none;
    font-family: ${(props) => props.theme.fonts.mono};
    font-size: ${(props) => (props.multiline ? "0.8rem" : "0.9rem")};
    text-align: center;
    width: auto;
    text-transform: uppercase;
    border-left: 3px solid transparent;
    ${(props) => props.multiline && `line-height: 1em;`}
    text-decoration: none;

    &:hover,
    &:focus,
    &:active {
        background-color: ${(props) => props.theme.colors.background.light};
        text-decoration: none;
    }

    margin-left: auto;

    @media all and (min-width: ${(props) => props.theme.widths.sm}) {
        font-size: ${(props) => (props.multiline ? "0.9rem" : "1.1rem")};
    }
`;

type PlayStartProps = {
    line: number;
    selectedLine: Dendriform<number>;
};

const PlayStart = styled(({ line, selectedLine, ...props }: PlayStartProps) => {
    const onClick = () => selectedLine.set(line);
    return (
        <span {...props} onClick={onClick}>
            {">"}
        </span>
    );
})`
    position: absolute;
    left: 0.8rem;
    border: none;
    display: block;
    cursor: pointer;
    color: ${(props) => props.theme.colors.text.placeholder};
    outline: none;
    opacity: ${(props) =>
        props.selectedLine.useValue() === props.line ? "1" : ".2"};
    pointer-events: auto;

    transition: opacity 0.2s ease-out;

    &:hover,
    &:focus,
    &:active {
        opacity: 1;
    }
`;
