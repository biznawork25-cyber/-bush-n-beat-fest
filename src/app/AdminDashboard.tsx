import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { LogOut, RefreshCw } from "lucide-react";
import { supabase } from "./services/supabase";
import { functionErrorMessage } from "./services/functionError";

type EventRow = {
  id: string;
  name: string;
  venue: string;
  event_date: string;
};

type PromoterRow = {
  id: string;
  name: string;
  code: string;
  commissionRate: number;
  isActive: boolean;
  paidOrders: number;
  revenue: number;
  commissionDue: number;
};

type Summary = {
  event: { id: string; name: string; venue: string; eventDate: string };
  orders: number;
  paidOrders: number;
  revenue: number;
  commissionDue: number;
  ticketsIssued: number;
  ticketsCheckedIn: number;
  promoters: PromoterRow[];
};

type PendingPayment = {
  paymentId: string;
  orderId: string;
  bookingReference: string;
  customerName: string;
  customerPhone: string;
  quantity: number;
  amount: number;
  ticketType: string;
  mpesaCode: string;
  submittedAt: string | null;
};

type CheckInResult = {
  result: "CHECKED_IN" | "ALREADY_USED" | "NOT_FOUND" | "NOT_PAID";
  ticketType?: string;
  customerName?: string;
  bookingReference?: string;
  checkedInAt?: string;
};

const panelStyle = {
  background: "#142313",
  border: "1px solid #31452b",
  borderRadius: 12,
};

function displayError(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

// GET when there is no body (events, summary, pending), POST when there is one.
async function invokeAdmin<T>(path: string, body?: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke(`server/${path}`, {
    method: body ? "POST" : "GET",
    ...(body ? { body } : {}),
  });
  if (error) throw new Error(await functionErrorMessage(error));
  return data as T;
}

export default function AdminDashboard() {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]>(null);
  const [email, setEmail] = useState("bushnbeatfest@gmail.com");
  const [password, setPassword] = useState("");
  const [events, setEvents] = useState<EventRow[]>([]);
  const [eventId, setEventId] = useState("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pending, setPending] = useState<PendingPayment[]>([]);
  const [busyPaymentId, setBusyPaymentId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [promoterName, setPromoterName] = useState("");
  const [newPromoter, setNewPromoter] = useState<PromoterRow | null>(null);
  const [ticketCode, setTicketCode] = useState("");
  const [checkInResult, setCheckInResult] = useState<CheckInResult | null>(null);
  const [eventForm, setEventForm] = useState({
    name: "",
    venue: "",
    eventDate: "",
    advancePrice: "300",
    gatePrice: "500",
  });
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const isCheckingInRef = useRef(false);
  const lastScanRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });

  useEffect(() => {
    let mounted = true;
    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!mounted) return;
      if (sessionError) setError(sessionError.message);
      if (
        data.session?.user.email?.toLowerCase() &&
        data.session.user.email.toLowerCase() !== "bushnbeatfest@gmail.com"
      ) {
        setError("This account is not authorized as the festival admin.");
        void supabase.auth.signOut();
        return;
      }
      setSession(data.session);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      if (
        next?.user.email?.toLowerCase() &&
        next.user.email.toLowerCase() !== "bushnbeatfest@gmail.com"
      ) {
        setError("This account is not authorized as the festival admin.");
        setSession(null);
        window.setTimeout(() => void supabase.auth.signOut(), 0);
        return;
      }
      setSession(next);
      if (!next) {
        setEvents([]);
        setSummary(null);
        setPending([]);
      }
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
      const scanner = scannerRef.current;
      if (scanner?.isScanning) {
        void scanner.stop().catch((scannerError: unknown) => {
          console.error("Could not stop QR scanner:", scannerError);
        });
      }
    };
  }, []);

  const loadEvents = useCallback(async () => {
    setError("");
    const result = await invokeAdmin<{ events: EventRow[] }>("admin/events");
    setEvents(result.events);
    setEventId((current) =>
      result.events.some((event) => event.id === current)
        ? current
        : result.events[0]?.id ?? ""
    );
  }, []);

  const loadSummary = useCallback(async (id: string) => {
    if (!id) {
      setSummary(null);
      return;
    }
    const result = await invokeAdmin<Summary>(
      `admin/summary?eventId=${encodeURIComponent(id)}`,
    );
    setSummary(result);
  }, []);

  const loadPending = useCallback(async (id: string) => {
    if (!id) {
      setPending([]);
      return;
    }
    const result = await invokeAdmin<{ payments: PendingPayment[] }>(
      `admin/pending-payments?eventId=${encodeURIComponent(id)}`,
    );
    setPending(result.payments ?? []);
  }, []);

  useEffect(() => {
    if (!session) return;
    let active = true;
    setLoading(true);
    void loadEvents()
      .catch((loadError: unknown) => {
        if (active) setError(displayError(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session, loadEvents]);

  useEffect(() => {
    if (!session || !eventId) return;
    let active = true;
    const refresh = () => {
      void Promise.all([loadSummary(eventId), loadPending(eventId)]).catch(
        (loadError: unknown) => {
          if (active) setError(displayError(loadError));
        },
      );
    };
    refresh();
    const timer = window.setInterval(refresh, 20000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [session, eventId, loadSummary, loadPending]);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) throw signInError;
      if (data.user?.email?.toLowerCase() !== "bushnbeatfest@gmail.com") {
        await supabase.auth.signOut();
        throw new Error("This account is not authorized as the festival admin.");
      }
      setPassword("");
      setSession(data.session);
    } catch (signInError) {
      setError(displayError(signInError));
    } finally {
      setLoading(false);
    }
  }

  async function reviewPayment(payment: PendingPayment, action: "approve" | "reject") {
    const amount = Number(payment.amount).toLocaleString();
    const question = action === "approve"
      ? `Approve ${payment.customerName}'s order?\n\nOnly approve if YOUR M-Pesa messages show code ${payment.mpesaCode} for KSh ${amount} sent from ${payment.customerPhone}.`
      : `Reject ${payment.customerName}'s order (code ${payment.mpesaCode})? The tickets go back on sale.`;
    if (!window.confirm(question)) return;

    setError("");
    setBusyPaymentId(payment.paymentId);
    try {
      await invokeAdmin(`admin/payments/${action}`, { paymentId: payment.paymentId });
      await Promise.all([loadPending(eventId), loadSummary(eventId)]);
    } catch (reviewError) {
      setError(displayError(reviewError));
    } finally {
      setBusyPaymentId("");
    }
  }

  async function createPromoter(event: FormEvent) {
    event.preventDefault();
    if (!eventId) return;
    setError("");
    setNewPromoter(null);
    try {
      const result = await invokeAdmin<{
        promoter: {
          id: string;
          name: string;
          referral_code: string;
          commission_rate: number;
          is_active: boolean;
        };
      }>(
        "admin/promoters",
        { eventId, name: promoterName },
      );
      const promoter = {
        id: result.promoter.id,
        name: result.promoter.name,
        code: result.promoter.referral_code,
        commissionRate: result.promoter.commission_rate,
        isActive: result.promoter.is_active,
        paidOrders: 0,
        revenue: 0,
        commissionDue: 0,
      };
      setNewPromoter(promoter);
      setPromoterName("");
      await loadSummary(eventId);
    } catch (createError) {
      setError(displayError(createError));
    }
  }

  async function createEdition(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await invokeAdmin<{ eventId: string }>("admin/events", {
        ...eventForm,
        advancePrice: Number(eventForm.advancePrice),
        gatePrice: Number(eventForm.gatePrice),
        eventDate: new Date(eventForm.eventDate).toISOString(),
      });
      setEventForm({
        name: "",
        venue: "",
        eventDate: "",
        advancePrice: "300",
        gatePrice: "500",
      });
      await loadEvents();
    } catch (createError) {
      setError(displayError(createError));
    }
  }

  async function checkIn(code = ticketCode) {
    const cleaned = code.trim();
    if (!cleaned || isCheckingInRef.current) return;
    isCheckingInRef.current = true;
    setError("");
    setCheckInResult(null);
    try {
      const result = await invokeAdmin<CheckInResult>("admin/check-in", {
        ticketCode: cleaned,
      });
      setCheckInResult(result);
      setTicketCode("");
      if (eventId) await loadSummary(eventId);
    } catch (checkError) {
      setError(displayError(checkError));
    } finally {
      isCheckingInRef.current = false;
    }
  }

  async function startScanner() {
    setError("");
    try {
      if (!scannerRef.current) {
        scannerRef.current = new Html5Qrcode("admin-qr-reader");
      }
      if (scannerRef.current.isScanning) return;
      await scannerRef.current.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => {
          if (isCheckingInRef.current) return;
          const now = Date.now();
          const last = lastScanRef.current;
          if (last.code === decodedText && now - last.at < 5000) return;
          lastScanRef.current = { code: decodedText, at: now };
          void checkIn(decodedText);
        },
        () => undefined,
      );
    } catch (scannerError) {
      setError(`Camera unavailable. Enter the ticket code manually. ${displayError(scannerError)}`);
    }
  }

  async function signOut() {
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) setError(signOutError.message);
  }

  if (!session) {
    return (
      <main className="min-h-screen flex items-center justify-center p-5" style={{ background: "#0a1a07", color: "#f4f4e8" }}>
        <form onSubmit={signIn} className="w-full max-w-md p-7 space-y-4" style={panelStyle}>
          <p className="text-lime-300 text-sm tracking-widest">BUSH N BEAT FEST</p>
          <h1 className="text-3xl font-bold">Admin sign in</h1>
          <p className="text-sm text-gray-300">The admin account is for the festival team. Promoters do not need accounts.</p>
          <label className="block text-sm">Email
            <input required type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1 w-full rounded-lg bg-black/30 p-3 text-white" />
          </label>
          <label className="block text-sm">Password
            <input required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 w-full rounded-lg bg-black/30 p-3 text-white" />
          </label>
          {error && <p role="alert" className="text-red-300 text-sm">{error}</p>}
          <button disabled={loading} className="w-full rounded-lg bg-lime-300 p-3 font-bold text-black disabled:opacity-50">{loading ? "Signing in…" : "Sign in"}</button>
        </form>
      </main>
    );
  }

  const sold = summary?.ticketsIssued ?? 0;
  const checkedIn = summary?.ticketsCheckedIn ?? 0;

  const stats = [
    ["Tickets sold", sold],
    ["Paid revenue", `KSh ${Number(summary?.revenue ?? 0).toLocaleString()}`],
    ["Awaiting approval", pending.length],
    ["Checked in", checkedIn],
    ["Still to arrive", Math.max(0, sold - checkedIn)],
    ["Promoter commission", `KSh ${Number(summary?.commissionDue ?? 0).toLocaleString()}`],
  ];

  return (
    <main className="min-h-screen p-4 text-white md:p-8" style={{ background: "#0a1a07" }}>
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm tracking-widest text-lime-300">BUSH N BEAT FEST</p>
            <h1 className="text-3xl font-bold">Admin dashboard</h1>
            <p className="text-sm text-gray-300">Signed in as {session.user.email}</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                void loadEvents()
                  .then(() =>
                    eventId
                      ? Promise.all([loadSummary(eventId), loadPending(eventId)])
                      : undefined
                  )
                  .catch((loadError: unknown) => setError(displayError(loadError)));
              }}
              className="rounded-lg border border-white/20 px-4 py-2"
            >
              <RefreshCw size={16} className="inline mr-2" />Refresh
            </button>
            <button onClick={() => void signOut()} className="rounded-lg border border-white/20 px-4 py-2"><LogOut size={16} className="inline mr-2" />Sign out</button>
          </div>
        </header>

        {error && <p role="alert" className="rounded-lg bg-red-950 p-3 text-red-200">{error}</p>}

        <section className="p-4" style={panelStyle}>
          <label className="block text-sm">Festival edition
            <select value={eventId} onChange={(event) => setEventId(event.target.value)} className="mt-2 w-full rounded-lg bg-black/30 p-3 md:max-w-xl">
              {events.map((event) => <option key={event.id} value={event.id}>{event.name} · {event.venue} · {new Date(event.event_date).toLocaleDateString()}</option>)}
            </select>
          </label>
        </section>

        <section className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {stats.map(([label, value]) => (
            <div key={label} className="p-4" style={panelStyle}>
              <p className="text-xs text-gray-300">{label}</p>
              <p className="mt-2 text-2xl font-bold text-lime-300">{value}</p>
            </div>
          ))}
        </section>

        <section className="space-y-4 p-5" style={panelStyle}>
          <div>
            <h2 className="text-xl font-bold">Payments awaiting approval</h2>
            <p className="mt-1 text-sm text-gray-300">
              Open your own M-Pesa messages. Approve only if the code, the amount AND the sender number all match.
              Never approve from a customer's screenshot.
            </p>
          </div>
          {pending.length === 0 ? (
            <p className="text-sm text-gray-300">Nothing waiting. New submissions appear here automatically.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-gray-300">
                  <tr>
                    <th className="py-2 pr-3">Submitted</th>
                    <th className="pr-3">Customer</th>
                    <th className="pr-3">Paid from</th>
                    <th className="pr-3">Ticket</th>
                    <th className="pr-3">Amount</th>
                    <th className="pr-3">M-Pesa code</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((payment) => (
                    <tr key={payment.paymentId} className="border-t border-white/10">
                      <td className="py-3 pr-3 whitespace-nowrap">{payment.submittedAt ? new Date(payment.submittedAt).toLocaleString() : "—"}</td>
                      <td className="pr-3">{payment.customerName}<br /><span className="text-xs text-gray-400">{payment.bookingReference}</span></td>
                      <td className="pr-3 font-mono">{payment.customerPhone}</td>
                      <td className="pr-3">{payment.quantity} × {payment.ticketType}</td>
                      <td className="pr-3 whitespace-nowrap">KSh {Number(payment.amount).toLocaleString()}</td>
                      <td className="pr-3 font-mono text-lime-300">{payment.mpesaCode}</td>
                      <td className="whitespace-nowrap">
                        <button
                          disabled={busyPaymentId === payment.paymentId}
                          onClick={() => void reviewPayment(payment, "approve")}
                          className="mr-2 rounded-lg bg-lime-300 px-3 py-2 font-bold text-black disabled:opacity-50"
                        >
                          Approve
                        </button>
                        <button
                          disabled={busyPaymentId === payment.paymentId}
                          onClick={() => void reviewPayment(payment, "reject")}
                          className="rounded-lg border border-red-400 px-3 py-2 text-red-300 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="space-y-4 p-5" style={panelStyle}>
            <h2 className="text-xl font-bold">Promoters · 5% commission</h2>
            <form onSubmit={createPromoter} className="flex gap-2">
              <input required maxLength={100} value={promoterName} onChange={(event) => setPromoterName(event.target.value)} placeholder="Promoter name" className="min-w-0 flex-1 rounded-lg bg-black/30 p-3" />
              <button disabled={!eventId} className="rounded-lg bg-lime-300 px-4 font-bold text-black">Create link</button>
            </form>
            {newPromoter && <div className="break-all rounded-lg bg-black/30 p-3 text-sm">
              Referral link: <a className="text-lime-300 underline" href={`${location.origin}/?ref=${encodeURIComponent(newPromoter.code)}`} target="_blank" rel="noreferrer">{location.origin}/?ref={newPromoter.code}</a>
            </div>}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-gray-300"><tr><th className="py-2">Promoter</th><th>Code</th><th>Paid</th><th>Commission</th></tr></thead>
                <tbody>{summary?.promoters.map((promoter) => (
                  <tr key={promoter.id} className="border-t border-white/10">
                    <td className="py-2">{promoter.name}</td>
                    <td>{promoter.code}</td>
                    <td>{promoter.paidOrders}</td>
                    <td>KSh {Number(promoter.commissionDue).toLocaleString()}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>

          <section className="space-y-4 p-5" style={panelStyle}>
            <h2 className="text-xl font-bold">One-time ticket check-in</h2>
            <div id="admin-qr-reader" className="max-w-md overflow-hidden rounded-lg bg-black/30" />
            <button onClick={() => void startScanner()} className="w-full rounded-lg border border-lime-300 px-4 py-3 text-lime-300">Start camera scanner</button>
            <form onSubmit={(event) => { event.preventDefault(); void checkIn(); }} className="flex gap-2">
              <input value={ticketCode} onChange={(event) => setTicketCode(event.target.value)} placeholder="Or enter ticket code" className="min-w-0 flex-1 rounded-lg bg-black/30 p-3" />
              <button className="rounded-lg bg-lime-300 px-4 font-bold text-black">Verify</button>
            </form>
            {checkInResult && <div aria-live="polite" className={`rounded-lg p-4 ${checkInResult.result === "CHECKED_IN" ? "bg-green-900" : "bg-amber-950"}`}>
              <p className="font-bold">{checkInResult.result.replaceAll("_", " ")}</p>
              {checkInResult.customerName && <p>{checkInResult.customerName} · {checkInResult.ticketType} · {checkInResult.bookingReference}</p>}
              {checkInResult.checkedInAt && <p>Previously checked in {new Date(checkInResult.checkedInAt).toLocaleString()}</p>}
            </div>}
          </section>
        </div>

        <section className="p-5" style={panelStyle}>
          <h2 className="mb-4 text-xl font-bold">Add a future edition</h2>
          <form onSubmit={createEdition} className="grid gap-3 md:grid-cols-2">
            <input required maxLength={150} placeholder="Event name" value={eventForm.name} onChange={(event) => setEventForm({ ...eventForm, name: event.target.value })} className="rounded-lg bg-black/30 p-3" />
            <input required maxLength={200} placeholder="Venue" value={eventForm.venue} onChange={(event) => setEventForm({ ...eventForm, venue: event.target.value })} className="rounded-lg bg-black/30 p-3" />
            <input required type="datetime-local" value={eventForm.eventDate} onChange={(event) => setEventForm({ ...eventForm, eventDate: event.target.value })} className="rounded-lg bg-black/30 p-3" />
            <div className="grid grid-cols-2 gap-3">
              <input required type="number" min="1" step="1" aria-label="Advance price in KSh" value={eventForm.advancePrice} onChange={(event) => setEventForm({ ...eventForm, advancePrice: event.target.value })} className="rounded-lg bg-black/30 p-3" />
              <input required type="number" min="1" step="1" aria-label="Gate price in KSh" value={eventForm.gatePrice} onChange={(event) => setEventForm({ ...eventForm, gatePrice: event.target.value })} className="rounded-lg bg-black/30 p-3" />
            </div>
            <button className="rounded-lg bg-lime-300 p-3 font-bold text-black md:col-span-2">Create edition with Advance and Gate tickets</button>
          </form>
        </section>
      </div>
    </main>
  );
}