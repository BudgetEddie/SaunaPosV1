// ===========================================================================
// THE MESSAGE BOXES — every "are you sure?", "type a name", and "that didn't
// work" in the app, drawn by us instead of by the browser.
//
// WHY THIS EXISTS
//   The app used to call the browser's own alert() / confirm() / prompt().
//   Those look fine until the browser decides to stop showing them — Chrome
//   has a "Prevent this page from creating additional dialogs" checkbox that
//   appears after a page pops a couple in a row, and once it's ticked EVERY
//   one of those boxes is silently ignored until the page is reloaded.
//
//   Silently is the problem. A suppressed box doesn't error; the browser
//   answers on the caller's behalf — "cancelled" — so the code politely stops
//   and the screen does nothing at all. That is exactly how Rename and Remove
//   on the Menu screen came to look broken while working perfectly, and it
//   took Void a charge and Refund a bill down with them.
//
//   Boxes we draw ourselves can't be switched off, match the rest of the app,
//   work properly under a finger on a tablet, and don't freeze the browser
//   while they're open.
//
// HOW A SCREEN USES IT
//   const dialog = useDialog();
//
//   await dialog.say("Give the item a name.");
//   if (!(await dialog.confirm("Delete this item?"))) return;
//   const name = await dialog.askText("Category name", { initial: category.name });
//
//   ⚠️ All three are `await`ed. The old browser versions stopped the world
//      until they were answered; these don't, so a call site that forgets the
//      await will carry straight on as if the question came back empty.
//
// ⚠️ THE ANSWER FROM askText HAS THREE STATES, and they are not the same:
//      "some text" — they typed something
//      ""          — they pressed Save with the box empty (a real answer)
//      null        — they cancelled
//    Refunds rely on this: an empty reason is allowed, cancelling is not. Test
//    `=== null`, never `if (!answer)`.
// ===========================================================================

import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";

type Kind = "SAY" | "CONFIRM" | "ASK";

// What the buttons hand back. Each public method below narrows this to the one
// shape its callers actually care about, so no screen ever sees the union.
type Answer = string | boolean | null;

type Request = {
  id: number;
  kind: Kind;
  title: string;
  message: string;
  initial: string;
  placeholder: string;
  confirmLabel: string;
  danger: boolean;
  resolve: (answer: Answer) => void;
};

type SayOptions = { title?: string };
type ConfirmOptions = { title?: string; confirmLabel?: string; danger?: boolean };
type AskOptions = { title?: string; initial?: string; placeholder?: string; confirmLabel?: string };

type Dialog = {
  say: (message: string, options?: SayOptions) => Promise<void>;
  confirm: (question: string, options?: ConfirmOptions) => Promise<boolean>;
  askText: (question: string, options?: AskOptions) => Promise<string | null>;
};

// The fallback for a component rendered outside the provider. It answers the
// way a cancelled box would, so nothing destructive can slip through.
const DialogContext = createContext<Dialog>({
  say: async () => {},
  confirm: async () => false,
  askText: async () => null,
});

export function useDialog() {
  return useContext(DialogContext);
}

export function DialogProvider({ children }: { children: ReactNode }) {
  // A QUEUE, not a single slot — and that difference matters. Several actions
  // ask two things in a row: Void a charge shows "are you sure?", then the
  // manager password box, then an error box if the server refuses. The manager
  // override provider next door drops a second request on the floor when one
  // is already open (it can afford to — a dropped approval just means "no").
  // Dropping a message here would mean an error the staff member never sees,
  // which is the very bug this file exists to kill. So they line up instead.
  const [queue, setQueue] = useState<Request[]>([]);
  const current = queue[0] ?? null;

  const nextId = useRef(1);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Which request has already been answered. Without this, a double-tap on OK
  // would resolve one box but pop two off the queue, swallowing whatever was
  // waiting behind it.
  const answered = useRef<Request | null>(null);

  const push = (req: Omit<Request, "id" | "resolve">) =>
    new Promise<Answer>((resolve) => {
      setQueue((q) => [...q, { ...req, id: nextId.current++, resolve }]);
    });

  const finish = (answer: Answer) => {
    if (!current || answered.current === current) return;
    answered.current = current;
    current.resolve(answer);
    setQueue((q) => q.slice(1));
  };

  // What cancelling means depends on what was asked. For a message there's
  // nothing to say no to; for a question it's "no"; for a text box it's the
  // null that means "cancelled" as opposed to the "" that means "left blank".
  const cancelValue = (kind: Kind): Answer => (kind === "CONFIRM" ? false : null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!current) return;
    if (current.kind === "ASK") finish(inputRef.current?.value ?? "");
    else if (current.kind === "CONFIRM") finish(true);
    else finish(null);
  };

  const dialog: Dialog = {
    say: (message, options = {}) =>
      push({
        kind: "SAY",
        title: options.title ?? "Notice",
        message,
        initial: "",
        placeholder: "",
        confirmLabel: "OK",
        danger: false,
      }).then(() => undefined),

    confirm: (question, options = {}) =>
      push({
        kind: "CONFIRM",
        title: options.title ?? "Please confirm",
        message: question,
        initial: "",
        placeholder: "",
        confirmLabel: options.confirmLabel ?? "OK",
        danger: options.danger ?? false,
      }).then((answer) => answer === true),

    askText: (question, options = {}) =>
      push({
        kind: "ASK",
        title: options.title ?? "Edit",
        message: question,
        initial: options.initial ?? "",
        placeholder: options.placeholder ?? "",
        confirmLabel: options.confirmLabel ?? "Save",
        danger: false,
      }).then((answer) => (typeof answer === "string" ? answer : null)),
  };

  return (
    <DialogContext.Provider value={dialog}>
      {children}
      {current && (
        <div
          className="dlg-back"
          onMouseDown={(e) => {
            // Only a click on the backdrop itself closes it — not one that
            // started inside the card and drifted out.
            if (e.target === e.currentTarget) finish(cancelValue(current.kind));
          }}
        >
          {/*
            Keyed by request id so React builds a fresh card for each one. That
            is what makes autoFocus fire again for a second box waiting in the
            queue — without the key, React would reuse the card and the focus
            (and so the Escape key) would land nowhere.
          */}
          <form
            key={current.id}
            className="dlg-card"
            onSubmit={submit}
            onKeyDown={(e) => {
              if (e.key === "Escape") finish(cancelValue(current.kind));
            }}
          >
            <div className="dlg-label">{current.title}</div>
            <p className="dlg-msg">{current.message}</p>

            {current.kind === "ASK" && (
              // Uncontrolled on purpose: the value is read from the box when
              // Save is pressed. A controlled one would need resetting every
              // time the queue moved on, for no gain.
              <input
                ref={inputRef}
                className="dlg-in"
                autoFocus
                autoComplete="off"
                defaultValue={current.initial}
                placeholder={current.placeholder}
                // Everything selected on arrival, so typing replaces the old
                // name rather than landing next to it.
                onFocus={(e) => e.currentTarget.select()}
              />
            )}

            <div style={{ display: "flex", gap: 9, marginTop: 16 }}>
              {/* A message has nothing to decline, so it gets one button. */}
              {current.kind !== "SAY" && (
                <button
                  type="button"
                  className="dlg-btn dlg-ghost"
                  onClick={() => finish(cancelValue(current.kind))}
                >
                  Cancel
                </button>
              )}
              <button
                type="submit"
                className={`dlg-btn ${current.danger ? "dlg-danger" : "dlg-go"}`}
                // Focus starts on this button when there's no text box, so
                // Enter and Escape have somewhere to land.
                autoFocus={current.kind !== "ASK"}
              >
                {current.confirmLabel}
              </button>
            </div>
          </form>
        </div>
      )}
    </DialogContext.Provider>
  );
}
