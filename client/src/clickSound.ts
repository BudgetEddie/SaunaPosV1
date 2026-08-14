// ============================================================================
// THE APP'S SOUNDS — a tick when staff tap something, a chime when a guest is
// checked out, a softer chime when food lands on a station board, and a short
// buzz when the app says no to something.
//
// WHAT IT IS
//   One listener, attached once when the app starts, that plays a short click
//   whenever anything tappable is pressed. It is NOT wired into individual
//   screens: there are hundreds of tappable things across the app and adding a
//   line to each would be a permanent tax on every future change.
//
//   The other three are exceptions, and deliberately so: each marks one
//   specific kind of moment rather than every tap, so each is called by hand
//   from the place that actually knows it happened.
//
// WHERE IT'S USED
//   start() is called once from client/src/main.tsx.
//   playCheckoutChime() is called from Checkout.tsx when the paid card appears.
//   playNewOrderChime() is called from StationBoard.tsx when work the cook
//     hasn't seen before arrives on their board.
//   playErrorSound() is called from DialogProvider.tsx, for every message box
//     that isn't just good news, and from OverrideProvider.tsx when a manager's
//     password is refused. Between those two, nothing else in the app needs to
//     call it directly — nearly every "you can't do that" already flows through
//     one or the other.
//   Shell.tsx reads and flips the on/off switch in the sidebar.
//
// ONE SWITCH COVERS ALL FOUR. The sidebar toggle silences the whole app
// rather than just the tapping — a room that wants quiet wants it for all of it.
//
// WHAT COUNTS AS TAPPABLE
//   Most clickable things in this app are plain <div>s with an onClick — the
//   menu tiles, the guest cards, the category chips, the toggle switches. So
//   looking only for <button> would leave the busiest parts of the till
//   silent. What they all share is `cursor: pointer`, which this uses as the
//   signal, alongside the real interactive elements.
// ============================================================================

const STORAGE_KEY = "clickSound";
const VOLUME = 0.35; // a tick, not a thump — it plays hundreds of times a shift

export function soundEnabled() {
  // Defaults to on. Anything other than an explicit "off" counts as on, so a
  // cleared or corrupted value fails towards working rather than silent.
  return localStorage.getItem(STORAGE_KEY) !== "off";
}

export function setSoundEnabled(on: boolean) {
  localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
}

// A few copies rather than one. Tapping quickly — three teas onto a tab — would
// otherwise cut each sound off to restart it, which sounds broken. Four is
// enough to overlap without a pile of audio objects hanging around.
const POOL_SIZE = 4;
let pool: HTMLAudioElement[] = [];
let next = 0;

function play() {
  if (!soundEnabled() || pool.length === 0) return;
  const audio = pool[next];
  next = (next + 1) % POOL_SIZE;
  audio.currentTime = 0;
  // Browsers reject audio that isn't tied to a real user action, and they
  // report it by rejecting this promise. It's harmless here — the sound is
  // decoration — so it's swallowed rather than left as an unhandled error in
  // the console on every tap.
  audio.play().catch(() => {});
}

// THE CHECKOUT CHIME. A guest is paid up and on their way out — this is the
// one sound in the app that means something happened rather than that a finger
// landed somewhere.
//
// Louder than the click on purpose. The tick plays hundreds of times a shift so
// it has to stay out of the way; this plays a few dozen times and wants to be
// heard across a busy front desk.
const CHIME_VOLUME = 0.7;
let chime: HTMLAudioElement | null = null;

export function playCheckoutChime() {
  if (!soundEnabled() || !chime) return;
  // Rewound rather than played fresh, so a second checkout close on the heels
  // of the first restarts the sound instead of layering two on top of it.
  chime.currentTime = 0;
  // Same swallowed rejection as the click. A browser that refuses to play it
  // has cost us a flourish, not a checkout.
  chime.play().catch(() => {});
}

// THE NEW-ORDER CHIME. Something has landed on a station board that the cook
// hasn't seen yet.
//
// Deliberately softer and lower than the checkout ding, and quieter here too.
// The two are the only "good news" sounds in the app and they can end up in
// earshot of each other, so they have to be tellable apart without looking:
// the bright rising one means money came in, this gentler one means there's
// work to do.
const NEW_ORDER_VOLUME = 0.6;
let newOrder: HTMLAudioElement | null = null;

export function playNewOrderChime() {
  if (!soundEnabled() || !newOrder) return;
  // Rewound rather than layered. A rush lands several tickets in a few seconds
  // and overlapping copies of a 1.4s chime would turn into a smear rather than
  // a count — restarting keeps each arrival a distinct, recognisable sound.
  newOrder.currentTime = 0;
  newOrder.play().catch(() => {});
}

// THE ERROR BUZZ. Short and flat on purpose — the opposite shape of the
// checkout chime, so the two ends of "good news" and "bad news" stay easy to
// tell apart without looking at the screen.
//
// This is the sound for "the app just said no": a blank name, a locker that
// was never picked, a manager's password that didn't match, a bill the server
// refused to touch. It is NOT for routine confirmations — saving the tax rate
// successfully doesn't buzz, it would teach staff to ignore the sound.
const ERROR_VOLUME = 0.55;
let errorSound: HTMLAudioElement | null = null;

export function playErrorSound() {
  if (!soundEnabled() || !errorSound) return;
  // Same rewind-not-queue approach as the chime — two refusals in a row
  // restart the buzz rather than stacking two on top of each other.
  errorSound.currentTime = 0;
  errorSound.play().catch(() => {});
}

// Is this element (or something it sits inside) meant to be tapped?
//
// Walks up a few levels because a tap usually lands on the text or the icon
// INSIDE a button rather than the button itself. Six is enough for the deepest
// tile in this app and stops it walking the whole page on every stray click.
function tappable(start: EventTarget | null): boolean {
  let el = start instanceof Element ? start : null;
  for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
    const tag = el.tagName;

    // Typing in a box isn't a tap. Checked before the rest so clicking into a
    // search field stays silent.
    if (tag === "INPUT") {
      const type = (el as HTMLInputElement).type;
      if (type !== "button" && type !== "submit" && type !== "checkbox" && type !== "radio") return false;
    }
    if (tag === "TEXTAREA") return false;

    // A disabled control does nothing, so it shouldn't sound like it did.
    if ((el as HTMLButtonElement).disabled) return false;

    if (tag === "BUTTON" || tag === "A" || tag === "SELECT" || tag === "OPTION") return true;
    if (el.getAttribute("role") === "button") return true;
    if (getComputedStyle(el).cursor === "pointer") return true;
  }
  return false;
}

export function start() {
  pool = Array.from({ length: POOL_SIZE }, () => {
    const a = new Audio("/sounds/click.wav");
    a.volume = VOLUME;
    a.preload = "auto";
    return a;
  });

  // Just the one, unlike the click's four. Two checkouts finishing in the same
  // second isn't a thing that happens at a front desk with one till.
  chime = new Audio("/sounds/checkout.mp3");
  chime.volume = CHIME_VOLUME;
  // Loaded up front so the first checkout of the day chimes on time rather
  // than a beat late while the file is still being fetched.
  chime.preload = "auto";

  newOrder = new Audio("/sounds/new-order.mp3");
  newOrder.volume = NEW_ORDER_VOLUME;
  newOrder.preload = "auto";

  errorSound = new Audio("/sounds/error.mp3");
  errorSound.volume = ERROR_VOLUME;
  errorSound.preload = "auto";

  // Capture phase, so the sound fires even if something further down stops the
  // event from bubbling — a few of the overlays do exactly that.
  document.addEventListener(
    "pointerdown",
    (e) => {
      // Left button / touch only. A right-click opens a menu, it isn't a tap.
      if (e.button !== 0) return;
      if (tappable(e.target)) play();
    },
    true
  );
}
