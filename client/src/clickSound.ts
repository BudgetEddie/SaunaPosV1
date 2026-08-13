// ============================================================================
// THE CLICK SOUND — a small tick when staff tap something.
//
// WHAT IT IS
//   One listener, attached once when the app starts, that plays a short click
//   whenever anything tappable is pressed. It is NOT wired into individual
//   screens: there are hundreds of tappable things across the app and adding a
//   line to each would be a permanent tax on every future change.
//
// WHERE IT'S USED
//   start() is called once from client/src/main.tsx.
//   Shell.tsx reads and flips the on/off switch in the sidebar.
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
