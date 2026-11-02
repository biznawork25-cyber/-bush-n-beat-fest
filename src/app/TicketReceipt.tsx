import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { supabase } from "./services/supabase";
import { functionErrorMessage } from "./services/functionError";

const HELPLINE = "0798 512 390";

type Ticket = {
  ticket_code: string;
  status: string;
  checked_in_at: string | null;
};

type Receipt = {
  bookingReference: string;
  customerName: string;
  quantity: number;
  amount: number;
  status: string;
  event?: { name: string; venue: string; event_date: string };
  ticketType?: string;
  paymentRequired: boolean;
  codeSubmitted: boolean;
  payTo?: string | null;
  payToName?: string | null;
  tickets: Ticket[];
};

export default function TicketReceipt() {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [qrCodes, setQrCodes] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [codeInput, setCodeInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const statusRef = useRef("");
  const token = new URLSearchParams(window.location.search).get("token") ?? "";

  const loadReceipt = useCallback(async () => {
    try {
      const { data, error: requestError } = await supabase.functions.invoke(
        "server/ticket-status",
        { body: { token } },
      );
      if (requestError) throw new Error(await functionErrorMessage(requestError));
      setReceipt(data as Receipt);
      setError("");
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not load ticket details.",
      );
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    statusRef.current = receipt?.status ?? "";
  }, [receipt]);

  useEffect(() => {
    if (!token || token.length > 200) {
      setError("This ticket link is invalid.");
      setLoading(false);
      return;
    }

    void loadReceipt();

    // Poll only while the order is still waiting, and only in a visible tab.
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (statusRef.current === "PAID" || statusRef.current === "FAILED") return;
      void loadReceipt();
    }, 15000);

    const onVisible = () => {
      if (document.visibilityState === "visible") void loadReceipt();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [token, loadReceipt]);

  useEffect(() => {
    let active = true;
    const generate = async () => {
      if (!receipt?.tickets.length) {
        setQrCodes({});
        return;
      }
      try {
        const entries = await Promise.all(
          receipt.tickets.map(async (ticket) => [
            ticket.ticket_code,
            await QRCode.toDataURL(ticket.ticket_code, {
              width: 256,
              margin: 1,
              errorCorrectionLevel: "M",
            }),
          ] as const),
        );
        if (active) setQrCodes(Object.fromEntries(entries));
      } catch (qrError) {
        console.error("Could not generate ticket QR codes:", qrError);
        if (active) setError("Ticket is confirmed but its QR code could not be displayed.");
      }
    };
    void generate();
    return () => {
      active = false;
    };
  }, [receipt]);

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    setSubmitError("");
    setSubmitting(true);
    try {
      const { error: requestError } = await supabase.functions.invoke(
        "server/submit-payment",
        { body: { token, mpesaCode: codeInput } },
      );
      if (requestError) throw new Error(await functionErrorMessage(requestError));
      setCodeInput("");
      await loadReceipt();
    } catch (submitProblem) {
      setSubmitError(
        submitProblem instanceof Error
          ? submitProblem.message
          : "Could not save your code. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const awaitingPayment =
    receipt?.status === "PENDING" && receipt.paymentRequired;

  return (
    <main className="min-h-screen px-4 py-10 text-white" style={{ background: "#0a1a07" }}>
      <article className="mx-auto max-w-2xl rounded-2xl border border-lime-900 bg-[#142313] p-6 md:p-10">
        <a href="/" className="text-sm tracking-widest text-lime-300">BUSH N BEAT FEST</a>
        <h1 className="mt-4 text-3xl font-bold">Your ticket</h1>
        {loading && <p className="mt-6 text-gray-300">Loading your order…</p>}
        {error && <p role="alert" className="mt-6 rounded-lg bg-red-950 p-4 text-red-200">{error}</p>}
        {receipt && (
          <>
            <div className="mt-6 rounded-xl bg-black/25 p-4">
              <p className="text-sm text-gray-300">Booking reference</p>
              <p className="font-mono text-xl text-lime-300">{receipt.bookingReference}</p>
              <p className="mt-3">{receipt.customerName} · {receipt.quantity} × {receipt.ticketType ?? "ticket"}</p>
              <p className="mt-1 text-sm text-gray-300">
                {receipt.event?.name}{receipt.event?.venue ? ` · ${receipt.event.venue}` : ""}
              </p>
              <p className="mt-1 text-sm text-gray-300">Total: KSh {Number(receipt.amount).toLocaleString()}</p>
            </div>

            {awaitingPayment && (
              <section className="mt-6 space-y-4 rounded-xl border border-lime-700/40 bg-black/25 p-5">
                {!receipt.codeSubmitted ? (
                  <>
                    <h2 className="text-xl font-bold text-lime-300">Pay, then enter your M-Pesa code</h2>
                    <ol className="list-decimal space-y-2 pl-5 text-gray-200">
                      <li>Open M-Pesa on your phone and choose <strong>Send Money</strong>.</li>
                      <li>
                        Send exactly <strong>KSh {Number(receipt.amount).toLocaleString()}</strong> to:
                        <p className="mt-2 font-mono text-2xl text-lime-300">{receipt.payTo ?? "—"}</p>
                        {receipt.payToName && <p className="text-sm text-gray-300">{receipt.payToName}</p>}
                      </li>
                      <li>
                        When the confirmation SMS arrives, type its 10-character code below
                        (letters and numbers, like <span className="font-mono">SGH7X2K9LM</span>).
                      </li>
                    </ol>
                    <p className="text-sm text-gray-300">
                      Pay from the phone number you used when ordering. Your ticket is issued only after
                      the organizer confirms the payment.
                    </p>
                  </>
                ) : (
                  <>
                    <h2 className="text-xl font-bold text-lime-300">Code received. Waiting for confirmation</h2>
                    <p className="text-gray-200">
                      Your ticket appears here as soon as the organizer confirms your payment in their M-Pesa
                      records. This page refreshes automatically, so keep this link.
                    </p>
                    <p className="text-sm text-gray-300">Typed the wrong code? Enter the correct one below.</p>
                  </>
                )}

                <form onSubmit={submitCode} className="flex flex-col gap-2 sm:flex-row">
                  <input
                    required
                    value={codeInput}
                    onChange={(event) => setCodeInput(event.target.value.toUpperCase())}
                    maxLength={14}
                    placeholder="M-Pesa code"
                    autoCapitalize="characters"
                    className="min-w-0 flex-1 rounded-lg bg-black/40 p-3 font-mono text-white"
                  />
                  <button
                    disabled={submitting}
                    className="rounded-lg bg-lime-300 px-5 py-3 font-bold text-black disabled:opacity-50"
                  >
                    {submitting ? "Saving…" : receipt.codeSubmitted ? "Update code" : "Submit code"}
                  </button>
                </form>
                {submitError && <p role="alert" className="text-sm text-red-300">{submitError}</p>}
              </section>
            )}

            {receipt.status === "PENDING" && !receipt.paymentRequired && (
              <div className="mt-6 rounded-xl border border-amber-500/40 bg-amber-950/50 p-4">
                <p className="font-semibold text-amber-200">Gate order recorded</p>
                <p className="mt-1 text-sm text-gray-300">
                  This is a request only, not a valid entry ticket. Pay at the entrance.
                </p>
              </div>
            )}

            {receipt.status === "FAILED" && (
              <div className="mt-6 rounded-xl border border-red-500/40 bg-red-950/50 p-4">
                <p className="font-semibold text-red-200">This order was not confirmed</p>
                <p className="mt-1 text-sm text-gray-300">
                  We could not verify the payment for this order, or no payment code was received in time.
                  If you did pay, call our helpline{" "}
                  <a href="tel:+254798512390" className="font-mono text-lime-300">{HELPLINE}</a> and quote
                  your booking reference.
                </p>
              </div>
            )}

            {receipt.status === "PAID" && (
              <section className="mt-6 space-y-4">
                <p className="rounded-xl bg-green-950 p-4 text-green-200">
                  Payment confirmed. Show one QR code for each ticket at the entrance. Each code can be
                  checked in once.
                </p>
                {receipt.tickets.map((ticket, index) => (
                  <div key={ticket.ticket_code} className="flex flex-col items-center gap-3 rounded-xl bg-white p-5 text-center text-gray-900">
                    {qrCodes[ticket.ticket_code]
                      ? <img src={qrCodes[ticket.ticket_code]} alt={`QR code for ticket ${index + 1}`} width={256} height={256} />
                      : <div className="h-64 w-64 animate-pulse bg-gray-200" aria-label="Generating ticket QR code" />}
                    <p className="font-semibold">Ticket {index + 1} · {ticket.status === "USED" ? "Checked in" : "Valid"}</p>
                    <p className="font-mono text-sm">{ticket.ticket_code}</p>
                    {qrCodes[ticket.ticket_code] && (
                      <a
                        href={qrCodes[ticket.ticket_code]}
                        download={`bush-n-beat-${ticket.ticket_code}.png`}
                        className="rounded-lg bg-lime-300 px-4 py-2 font-semibold text-black"
                      >
                        Download QR
                      </a>
                    )}
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </article>
    </main>
  );
}