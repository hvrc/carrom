// Windchimes on contact.
//
// Four voices, because four things happen:
//
//   piece   coins meeting coins — the chime, pentatonic, rings on
//   wall    a cushion — wood rather than metal: lower, brighter than a thud,
//           and damped so it knocks instead of ringing
//   queen   the queen struck — the same chime with a fifth and an octave
//           stacked on it, so she announces herself
//   pocket  something going down — a short rising figure, and a falling one
//           for the striker, which is a foul rather than a score
//
// Sliding makes no sound at all, because nothing is struck.
//
// The voice is deliberately soft-edged: a sine body, a gentle attack, and a
// low-pass that opens only a little with force. Bright metal reads as glass
// breaking when a dozen land at once; this is closer to a marimba or a wooden
// chime, which is what a scattering break wants to sound like.
//
// Each hit is one chime, and two things map from the impact:
//
//   pitch    slow taps land low in the scale, hard hits ring high
//   sustain  the harder the hit, the longer it rings
//
// Notes are quantised to a pentatonic scale, which is the whole trick behind
// windchimes: any set of pentatonic notes sounds intentional together, so a
// scattering break comes out as a chord rather than a mess.

// A major pentatonic, two octaves, in semitones from the root. Major sits
// softer than minor for something that rings this often.
const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
// An octave below middle C: the low end is where the bluntness lives.
const ROOT_HZ = 130.81;
// Where the loudness scale peaks, in board units per tick. Everything at or
// above this is as loud as the board gets, so it wants to sit near the top of
// what actually happens — too low and a fifth of every break arrives at the
// same maximum and the shot loses its dynamics.
//
// Re-measured over 1190 impacts after the friction and cushion change, which
// left pieces travelling faster and hitting harder: median 6, p90 19, p95 24,
// loudest 39. At the old 16 16% of impacts clipped; at 24 it is 5%, which is
// about right — the hardest hits in a break should peak.
const IMPACT_CEILING = 24;

let ctx = null;
let bus = null;
let enabled = false;
// Chimes are cheap but a full break can fire a dozen in one tick; this keeps a
// pile-up from clipping the output.
let voices = 0;
const MAX_VOICES = 10;

function ensureContext() {
    if (ctx) return ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    bus = ctx.createGain();
    bus.gain.value = 0.22;              // headroom: several chimes may overlap

    // The blunt edge: everything above this rolls off, so no chime can get
    // glassy however hard the hit.
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 1400;
    tone.Q.value = 0.4;

    bus.connect(tone).connect(ctx.destination);
    return ctx;
}

/**
 * Turn sound on or off. Must be called from a user gesture the first time —
 * browsers refuse to start an AudioContext otherwise.
 */
export function setAudioEnabled(on) {
    enabled = !!on;
    if (!enabled) return false;
    const c = ensureContext();
    if (!c) { enabled = false; return false; }
    if (c.state === "suspended") c.resume();
    return true;
}

export const isAudioEnabled = () => enabled;

/**
 * Sound one impact.
 * @param {number} speed  closing speed at contact, in board units per tick
 * @param {number} pan    -1..1, where across the board it happened
 * @param {string} kind   "piece" (a chime) or "wall" (a knock)
 */
export function chime(speed, pan = 0, kind = "piece") {
    if (!enabled || !ctx || voices >= MAX_VOICES) return;

    const wall = kind === "wall";
    const queen = kind === "queen";
    const force = Math.min(1, Math.max(0, speed / IMPACT_CEILING));
    // Pitch: up the scale with force, with a little scatter so repeated hits of
    // the same strength do not sound mechanical.
    const step = Math.min(
        SCALE.length - 1,
        Math.floor(force * (SCALE.length - 1) + Math.random() * 1.4),
    );
    // A cushion is a fixed piece of wood: it does not climb a scale with the
    // hit the way a struck coin does. It sits low and only gains weight.
    const hz = wall
        ? ROOT_HZ * 0.92 * (1 + force * 0.16)
        : ROOT_HZ * Math.pow(2, SCALE[step] / 12);

    // Sustain: a tap dies away, a hard strike rings on. A cushion barely rings
    // at all — the board absorbs it.
    const decay = wall ? 0.16 + force * 0.26 : (queen ? 1.6 + force * 2.4 : 0.45 + force * 2.2);
    const peak = wall ? 0.08 + force * 0.26 : 0.1 + force * 0.4;
    const now = ctx.currentTime;
    // Attack: slow enough that there is no click at the front of the note. A
    // 6ms attack is what made the old voice sound sharp.
    const attack = 0.03 - force * 0.012;

    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) panner.pan.value = Math.max(-1, Math.min(1, pan));

    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, now);
    out.gain.exponentialRampToValueAtTime(peak, now + attack);
    out.gain.exponentialRampToValueAtTime(0.0001, now + decay);

    // A second filter per voice, opening a little with force, so a hard hit is
    // brighter than a soft one without ever being bright.
    const colour = ctx.createBiquadFilter();
    colour.type = "lowpass";
    colour.frequency.setValueAtTime(
        wall ? 900 + force * 1100 : (queen ? 1800 + force * 1200 : 700 + force * 900), now);
    colour.frequency.exponentialRampToValueAtTime(wall ? 380 : 320, now + decay);
    colour.Q.value = 0.6;

    // Sine body, an octave above it for weight, and only a whisper of the fifth.
    // The old triangle plus an inharmonic partial is what made it ring sharp.
    const partials = wall
        // A knock: body, a woody second, and a little air on top so it reads as
        // a rap on a board rather than a thud in a box.
        ? [
            { hz, gain: 1, type: "sine" },
            { hz: hz * 2.02, gain: 0.34, type: "triangle" },
            { hz: hz * 3.4, gain: 0.12, type: "sine" },
        ]
        : queen
            // Her own chord: the note, its fifth and its octave, struck together
            // and left to ring. Nothing else on the board sounds like this.
            ? [
                { hz: hz * 2, gain: 1, type: "sine" },
                { hz: hz * 3, gain: 0.45, type: "sine" },
                { hz: hz * 4, gain: 0.3, type: "sine" },
                { hz: hz * 6, gain: 0.12, type: "sine" },
            ]
            : [
                { hz, gain: 1, type: "sine" },
                { hz: hz * 2 * (1 + (Math.random() - 0.5) * 0.004), gain: 0.22, type: "sine" },
                { hz: hz * 3, gain: 0.05, type: "sine" },
            ];

    voices += 1;
    const oscillators = partials.map((p) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = p.type;
        osc.frequency.value = p.hz;
        g.gain.value = p.gain;
        osc.connect(g).connect(colour).connect(out);
        osc.start(now);
        osc.stop(now + decay + 0.05);
        return osc;
    });

    if (panner) out.connect(panner).connect(bus);
    else out.connect(bus);

    oscillators[0].onended = () => { voices = Math.max(0, voices - 1); };
}

/**
 * Something went down. A coin is a short rising figure; the queen is the same
 * but wider and brighter; the striker falls instead, because putting the
 * striker away is a foul and should not sound like a reward.
 *
 * @param {string} kind    "coin" | "queen" | "striker"
 * @param {number} pan     -1..1
 */
export function pocket(kind = "coin", pan = 0) {
    if (!enabled || !ctx) return;

    // Semitones from the root, played in order.
    const figure =
        kind === "striker" ? [7, 0, -5] :
        kind === "queen" ? [12, 19, 24, 28] :
        [12, 19];

    const base = kind === "striker" ? ROOT_HZ * 0.75 : ROOT_HZ;
    const gap = kind === "queen" ? 0.085 : 0.1;
    const now = ctx.currentTime;

    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) panner.pan.value = Math.max(-1, Math.min(1, pan));

    figure.forEach((semitone, i) => {
        const at = now + i * gap;
        const hz = base * Math.pow(2, semitone / 12);
        const decay = kind === "striker" ? 0.5 : 0.9 + i * 0.25;

        const out = ctx.createGain();
        out.gain.setValueAtTime(0.0001, at);
        out.gain.exponentialRampToValueAtTime(kind === "striker" ? 0.16 : 0.2, at + 0.02);
        out.gain.exponentialRampToValueAtTime(0.0001, at + decay);

        const tone = ctx.createBiquadFilter();
        tone.type = "lowpass";
        tone.frequency.value = kind === "striker" ? 700 : 2600;

        for (const [mult, gain] of [[1, 1], [2, 0.3], [3, 0.1]]) {
            const osc = ctx.createOscillator();
            const g = ctx.createGain();
            osc.type = "sine";
            osc.frequency.value = hz * mult;
            g.gain.value = gain;
            osc.connect(g).connect(tone).connect(out);
            osc.start(at);
            osc.stop(at + decay + 0.05);
        }

        if (panner) out.connect(panner).connect(bus);
        else out.connect(bus);
    });
}

export default chime;
