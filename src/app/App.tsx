import { lazy, Suspense, useState, useEffect } from "react";
import { supabase } from "./services/supabase";
import { functionErrorMessage } from "./services/functionError";
import {
  MapPin,
  Calendar,
  Clock,
  Ticket,
  X,
  CheckCircle,
  ChevronDown,
  Trees,
  Zap,
  Phone,
  AlertCircle,
} from "lucide-react";

const AdminDashboard = lazy(() => import("./AdminDashboard"));
const TicketReceipt = lazy(() => import("./TicketReceipt"));

const HELPLINE_DISPLAY = "0798 512 390";
const HELPLINE_TEL = "tel:+254798512390";

// ─── COUNTDOWN ───────────────────────────────────────────────────────────────

function useCountdown(target: number) {
  const [delta, setDelta] = useState(target - Date.now());

  useEffect(() => {
    const t = setInterval(() => setDelta(target - Date.now()), 1000);

    return () => clearInterval(t);
  }, [target]);

  const s = Math.max(0, Math.floor(delta / 1000));

  return {
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
  };
}

// ─── TICKET MODAL ────────────────────────────────────────────────────────────

type TicketType = "advance" | "gate";

type EventChoice = {
  id: string;
  name: string;
  venue: string;
  event_date: string;
  ticketTypeId: string;
  price: number;
};

type TicketModalProps = {
  type: TicketType;
  onClose: () => void;
};

function TicketModal({ type, onClose }: TicketModalProps) {
  const [step, setStep] = useState<"form" | "success">("form");
  const [form, setForm] = useState({
    name: "",
    phone: "",
    qty: 1,
  });
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [bookingReference, setBookingReference] = useState("");
  const [ticketUrl, setTicketUrl] = useState("");
  const [eventChoices, setEventChoices] = useState<EventChoice[]>([]);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [eventsLoading, setEventsLoading] = useState(true);

  const label = type === "advance" ? "Advance" : "Gate";
  const selectedEvent = eventChoices.find((event) => event.id === selectedEventId);
  const price = selectedEvent?.price ?? 0;
  const total = price * form.qty;

  useEffect(() => {
    let active = true;
    const loadUpcomingTickets = async () => {
      setErr("");
      try {
        const { data: eventRows, error: eventError } = await supabase
          .from("events")
          .select("id, name, venue, event_date")
          .order("event_date", { ascending: true });

        if (eventError) throw eventError;

        const upcomingEvents = (eventRows ?? []).filter(
          (event) => new Date(event.event_date).getTime() >= Date.now(),
        );
        if (!upcomingEvents.length) {
          if (active) setEventChoices([]);
          return;
        }

        const { data: ticketTypes, error: ticketTypesError } = await supabase
          .from("ticket_types")
          .select("id, event_id, name, price, is_active")
          .in("event_id", upcomingEvents.map((event) => event.id))
          .eq("name", label)
          .eq("is_active", true);

        if (ticketTypesError) throw ticketTypesError;

        const choices = upcomingEvents.flatMap((event) => {
          const ticket = ticketTypes?.find((item) => item.event_id === event.id);
          return ticket
            ? [{
                ...event,
                ticketTypeId: ticket.id,
                price: Number(ticket.price),
              }]
            : [];
        });

        if (active) {
          setEventChoices(choices);
          setSelectedEventId((current) =>
            choices.some((event) => event.id === current)
              ? current
              : choices[0]?.id ?? ""
          );
        }
      } catch (loadError) {
        if (active) {
          setErr(
            loadError instanceof Error
              ? loadError.message
              : "Could not load ticket editions.",
          );
        }
      } finally {
        if (active) setEventsLoading(false);
      }
    };

    void loadUpcomingTickets();
    return () => {
      active = false;
    };
  }, [label]);

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      setErr("Please enter your full name.");
      return;
    }

    const cleanPhone = form.phone.replace(/\s/g, "");

    if (!/^(?:\+254|07|01)\d{8,9}$/.test(cleanPhone)) {
      setErr("Enter a valid Kenyan phone number.");
      return;
    }

    setErr("");
    setLoading(true);

    try {
      if (!selectedEvent) {
        throw new Error("Select an available festival edition.");
      }

      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const receiptToken = Array.from(tokenBytes, (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
      const tokenDigest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(receiptToken),
      );
      const receiptTokenHash = Array.from(new Uint8Array(tokenDigest), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
      const referralCode = new URLSearchParams(window.location.search).get("ref");

      const { data, error } = await supabase.functions.invoke(
        "server/create-order",
        {
          body: {
            eventId: selectedEvent.id,
            ticketTypeId: selectedEvent.ticketTypeId,
            customerName: form.name.trim(),
            customerPhone: cleanPhone,
            quantity: form.qty,
            receiptTokenHash,
            referralCode,
          },
        }
      );

      if (error) {
        console.error("Create order error:", error);
        throw new Error(await functionErrorMessage(error));
      }

      if (!data?.success) {
        throw new Error(data?.error || "Could not create your ticket order.");
      }

      const url = `/ticket?token=${encodeURIComponent(receiptToken)}`;

      // Advance tickets: go straight to the private ticket page, which shows
      // where to send the money and where to enter the M-Pesa code.
      if (data.payment?.status === "PENDING") {
        window.location.assign(url);
        return;
      }

      setBookingReference(data.order.bookingReference);
      setTicketUrl(url);
      setStep("success");
    } catch (error) {
      console.error("Ticket purchase error:", error);

      setErr(
        error instanceof Error
          ? error.message
          : "Something went wrong. Please try again."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{
        background: "rgba(0,0,0,0.85)",
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        className="w-full max-w-md rounded-2xl overflow-hidden"
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
        }}
      >
        <div
          className="px-6 py-5 flex items-center justify-between"
          style={{
            borderBottom: "1px solid var(--border)",
            background:
              type === "advance"
                ? "rgba(200,255,0,0.06)"
                : "rgba(255,85,0,0.06)",
          }}
        >
          <div>
            <p
              style={{
                fontFamily: "'Anton', sans-serif",
                fontSize: 22,
                color:
                  type === "advance"
                    ? "var(--primary)"
                    : "var(--accent)",
                letterSpacing: "0.05em",
              }}
            >
              {label.toUpperCase()} TICKET
            </p>

            <p
              style={{
                fontSize: 13,
                color: "var(--muted-foreground)",
                fontFamily: "'Space Mono', monospace",
              }}
            >
              KSh {price.toLocaleString()} per person
            </p>
          </div>

          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center hover:opacity-70"
            style={{
              background: "var(--secondary)",
            }}
          >
            <X
              size={15}
              style={{
                color: "var(--foreground)",
              }}
            />
          </button>
        </div>

        {step === "form" ? (
          <div className="px-6 py-5 flex flex-col gap-4">
            <div>
              <label
                style={{
                  fontSize: 11,
                  fontFamily: "'Space Mono', monospace",
                  color: "var(--muted-foreground)",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  display: "block",
                  marginBottom: 6,
                }}
              >
                Festival Edition
              </label>
              {eventsLoading ? (
                <p style={{ color: "var(--muted-foreground)", fontSize: 13 }}>Loading available editions…</p>
              ) : eventChoices.length ? (
                <select
                  value={selectedEventId}
                  onChange={(event) => setSelectedEventId(event.target.value)}
                  className="w-full px-4 py-3 rounded-xl outline-none"
                  style={{
                    background: "var(--secondary)",
                    border: "1px solid var(--border)",
                    color: "var(--foreground)",
                    fontFamily: "'Nunito', sans-serif",
                    fontSize: 14,
                  }}
                >
                  {eventChoices.map((event) => (
                    <option key={event.id} value={event.id}>
                      {event.name} · {new Date(event.event_date).toLocaleDateString()}
                    </option>
                  ))}
                </select>
              ) : (
                <p style={{ color: "var(--muted-foreground)", fontSize: 13 }}>No upcoming {label.toLowerCase()} tickets are available.</p>
              )}
            </div>

            <div>
              <label
                style={{
                  fontSize: 11,
                  fontFamily: "'Space Mono', monospace",
                  color: "var(--muted-foreground)",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  display: "block",
                  marginBottom: 6,
                }}
              >
                Full Name
              </label>

              <input
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    name: e.target.value,
                  }))
                }
                placeholder="e.g. Grace Wanjiru"
                className="w-full px-4 py-3 rounded-xl outline-none"
                style={{
                  background: "var(--secondary)",
                  border: "1px solid var(--border)",
                  color: "var(--foreground)",
                  fontFamily: "'Nunito', sans-serif",
                  fontSize: 14,
                }}
              />
            </div>

            <div>
              <label
                style={{
                  fontSize: 11,
                  fontFamily: "'Space Mono', monospace",
                  color: "var(--muted-foreground)",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  display: "block",
                  marginBottom: 6,
                }}
              >
                {type === "advance" ? "M-Pesa number you'll pay from" : "Phone number"}
              </label>

              <input
                value={form.phone}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    phone: e.target.value,
                  }))
                }
                placeholder="07XX XXX XXX"
                className="w-full px-4 py-3 rounded-xl outline-none"
                style={{
                  background: "var(--secondary)",
                  border: "1px solid var(--border)",
                  color: "var(--foreground)",
                  fontFamily: "'Space Mono', monospace",
                  fontSize: 14,
                }}
              />
            </div>

            <div>
              <label
                style={{
                  fontSize: 11,
                  fontFamily: "'Space Mono', monospace",
                  color: "var(--muted-foreground)",
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  display: "block",
                  marginBottom: 6,
                }}
              >
                Number of Tickets
              </label>

              <div className="flex items-center gap-3">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() =>
                      setForm((f) => ({
                        ...f,
                        qty: n,
                      }))
                    }
                    className="w-11 h-11 rounded-xl font-bold transition-all"
                    style={{
                      fontFamily: "'Space Mono', monospace",
                      background:
                        form.qty === n
                          ? "var(--primary)"
                          : "var(--secondary)",
                      color:
                        form.qty === n
                          ? "var(--primary-foreground)"
                          : "var(--foreground)",
                      border: `1px solid ${
                        form.qty === n
                          ? "var(--primary)"
                          : "var(--border)"
                      }`,
                    }}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div
              className="rounded-xl px-4 py-3 flex gap-3"
              style={{
                background: "rgba(200,255,0,0.05)",
                border: "1px solid rgba(200,255,0,0.2)",
              }}
            >
              <Phone
                size={16}
                style={{
                  color: "var(--primary)",
                  marginTop: 2,
                  flexShrink: 0,
                }}
              />

              <div>
                <p
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: "var(--primary)",
                    fontFamily: "'Nunito', sans-serif",
                    marginBottom: 2,
                  }}
                >
                  {type === "advance"
                    ? "Pay by M-Pesa Send Money"
                    : "Ticket order"}
                </p>

                <p
                  style={{
                    fontSize: 12,
                    color: "var(--muted-foreground)",
                    fontFamily: "'Nunito', sans-serif",
                    lineHeight: 1.5,
                  }}
                >
                  {type === "advance"
                    ? "Next you'll see our M-Pesa number and the exact amount to send. After paying, enter your M-Pesa code. Your QR ticket is issued once the organizer confirms your payment."
                    : "Your gate ticket order will be recorded for the event."}
                  <br />
                  Total:{" "}
                  <strong
                    style={{
                      color: "var(--foreground)",
                    }}
                  >
                    KSh {total.toLocaleString()}
                  </strong>
                </p>
              </div>
            </div>

            {err && (
              <div
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl"
                style={{
                  background: "rgba(220,38,38,0.1)",
                  border: "1px solid rgba(220,38,38,0.3)",
                }}
              >
                <AlertCircle
                  size={14}
                  style={{
                    color: "#f87171",
                  }}
                />

                <p
                  style={{
                    fontSize: 12,
                    color: "#f87171",
                    fontFamily: "'Nunito', sans-serif",
                  }}
                >
                  {err}
                </p>
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={loading || eventsLoading || !selectedEvent}
              className="w-full py-4 rounded-xl font-bold tracking-wider transition-all hover:brightness-110 active:scale-95"
              style={{
                background:
                  type === "advance"
                    ? "var(--primary)"
                    : "var(--accent)",
                color:
                  type === "advance"
                    ? "var(--primary-foreground)"
                    : "white",
                fontFamily: "'Anton', sans-serif",
                fontSize: 18,
                letterSpacing: "0.1em",
                opacity: loading ? 0.7 : 1,
                cursor: loading ? "not-allowed" : "pointer",
              }}
            >
              {loading
                ? "CREATING ORDER..."
                : type === "advance"
                  ? `CONTINUE TO PAYMENT — KSh ${total.toLocaleString()}`
                  : "RECORD GATE ORDER"}
            </button>
          </div>
        ) : (
          <div className="px-6 py-8 flex flex-col items-center text-center gap-4">
            <div
              className="w-20 h-20 rounded-full flex items-center justify-center"
              style={{
                background: "rgba(200,255,0,0.1)",
                border: "2px solid var(--primary)",
              }}
            >
              <CheckCircle
                size={36}
                style={{
                  color: "var(--primary)",
                }}
              />
            </div>

            <div>
              <p
                style={{
                  fontFamily: "'Anton', sans-serif",
                  fontSize: 26,
                  color: "var(--primary)",
                  letterSpacing: "0.05em",
                }}
              >
                ORDER CREATED!
              </p>

              <p
                style={{
                  fontSize: 14,
                  color: "var(--muted-foreground)",
                  fontFamily: "'Nunito', sans-serif",
                  marginTop: 4,
                }}
              >
                {form.qty} × {label} Ticket
                {form.qty > 1 ? "s" : ""} · KSh {total.toLocaleString()}
              </p>
            </div>

            <div
              className="w-full rounded-xl px-5 py-4"
              style={{
                background: "var(--secondary)",
                border: "1px solid var(--border)",
              }}
            >
              <p
                style={{
                  fontSize: 11,
                  fontFamily: "'Space Mono', monospace",
                  color: "var(--muted-foreground)",
                  marginBottom: 4,
                }}
              >
                BOOKING REFERENCE
              </p>

              <p
                style={{
                  fontSize: 22,
                  fontFamily: "'Space Mono', monospace",
                  color: "var(--primary)",
                  fontWeight: 700,
                }}
              >
                {bookingReference}
              </p>
            </div>

            <p
              style={{
                fontSize: 13,
                color: "var(--muted-foreground)",
                fontFamily: "'Nunito', sans-serif",
                lineHeight: 1.6,
              }}
            >
              This gate order is a request only, not a valid entry ticket. Pay at the entrance.
            </p>

            <a
              href={ticketUrl}
              className="w-full rounded-xl py-3 text-center font-bold transition-all hover:opacity-80"
              style={{
                background: "var(--primary)",
                color: "var(--primary-foreground)",
                fontFamily: "'Nunito', sans-serif",
              }}
            >
              Open private order page
            </a>

            <button
              onClick={onClose}
              className="w-full py-3 rounded-xl font-bold transition-all hover:opacity-80"
              style={{
                background: "var(--secondary)",
                color: "var(--foreground)",
                fontFamily: "'Nunito', sans-serif",
              }}
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── COUNTDOWN BLOCK ─────────────────────────────────────────────────────────

function CountdownBlock() {
  const EVENT_DATE = new Date(
    "2026-12-19T18:00:00+03:00"
  ).getTime();

  const { days, hours, minutes, seconds } =
    useCountdown(EVENT_DATE);

  return (
    <div className="flex items-center justify-center gap-3 flex-wrap">
      {[
        ["DAYS", days],
        ["HRS", hours],
        ["MIN", minutes],
        ["SEC", seconds],
      ].map(([label, val]) => (
        <div
          key={label}
          className="flex flex-col items-center px-5 py-4 rounded-xl min-w-[72px]"
          style={{
            background: "var(--secondary)",
            border: "1px solid var(--border)",
          }}
        >
          <p
            style={{
              fontFamily: "'Anton', sans-serif",
              fontSize: 42,
              color: "var(--primary)",
              lineHeight: 1,
              letterSpacing: "0.03em",
            }}
          >
            {String(val).padStart(2, "0")}
          </p>

          <p
            style={{
              fontFamily: "'Space Mono', monospace",
              fontSize: 10,
              color: "var(--muted-foreground)",
              letterSpacing: "0.12em",
              marginTop: 4,
            }}
          >
            {label}
          </p>
        </div>
      ))}
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────

function HomePage() {
  const [modal, setModal] = useState<TicketType | null>(null);
  const [faqOpen, setFaqOpen] = useState<number | null>(null);

  const faqs: Array<[string, string]> = [
    [
      "How do I buy an Advance ticket?",
      "Tap Advance, enter your name and the M-Pesa number you'll pay from, and continue. You'll see our payment number and the exact amount. Send that amount using M-Pesa Send Money, then type the confirmation code from the M-Pesa SMS into your private ticket page.",
    ],
    [
      "When do I get my QR ticket?",
      "Your QR ticket appears on your private ticket page once the organizer confirms your payment in the M-Pesa records. The page refreshes by itself, so keep the link open or saved. If it hasn't appeared after a while, call the helpline below with your booking reference.",
    ],
    [
      "I typed the wrong M-Pesa code. What now?",
      "Open your ticket page and enter the correct code again before your payment is confirmed. Each M-Pesa code can only be used once, and a code that was already used on another order will be rejected.",
    ],
    [
      "Does each QR code work more than once?",
      "No. Every ticket has its own unique QR code and it can be checked in once only. Keep your QR code private and don't share screenshots of it.",
    ],
    [
      "How much are tickets, and can I pay at the gate?",
      "Advance tickets are KSh 300 and gate tickets are KSh 500, so you save KSh 200 by booking in advance. Gate tickets are paid on arrival, and no online booking is needed.",
    ],
    [
      "Where and when is the event?",
      "19 December 2026 at Njukiini Forest Lodge, Kirinyaga County. DJ QUAN is the headline act.",
    ],
  ];

  return (
    <div
      className="min-h-screen"
      style={{
        background: "var(--background)",
        fontFamily: "'Nunito', sans-serif",
      }}
    >
      {/* NAV */}
      <nav
        className="fixed top-0 left-0 right-0 z-40 flex items-center justify-between px-6 py-4"
        style={{
          background: "rgba(10,26,7,0.88)",
          backdropFilter: "blur(12px)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <p
          style={{
            fontFamily: "'Anton', sans-serif",
            fontSize: 18,
            color: "var(--primary)",
            letterSpacing: "0.12em",
          }}
        >
          BUSH N BEAT FEST
        </p>

        <button
          onClick={() => setModal("advance")}
          className="flex items-center gap-2 px-4 py-2 rounded-lg font-bold text-sm transition-all hover:brightness-110 active:scale-95"
          style={{
            background: "var(--primary)",
            color: "var(--primary-foreground)",
            fontFamily: "'Space Mono', monospace",
            fontSize: 12,
          }}
        >
          <Ticket size={13} />
          BUY TICKETS
        </button>
      </nav>

      {/* HERO */}
      <section className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden pt-16">
        <div className="absolute inset-0 bg-green-950">
          <img
            src="https://images.unsplash.com/photo-1542273917363-3b1817f69a2d?w=1600&h=900&fit=crop&auto=format"
            alt="Dense forest at Njukiini"
            className="w-full h-full object-cover opacity-40"
          />

          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(to bottom, rgba(10,26,7,0.5) 0%, rgba(10,26,7,0.2) 50%, rgba(10,26,7,0.95) 100%)",
            }}
          />
        </div>

        <div
          className="absolute"
          style={{
            width: 600,
            height: 600,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(200,255,0,0.06) 0%, transparent 70%)",
            top: "20%",
            left: "50%",
            transform: "translateX(-50%)",
          }}
        />

        <div className="relative z-10 text-center px-4 max-w-5xl mx-auto">
          <div
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full mb-6"
            style={{
              background: "rgba(200,255,0,0.1)",
              border: "1px solid rgba(200,255,0,0.3)",
            }}
          >
            <div
              className="w-2 h-2 rounded-full animate-pulse"
              style={{
                background: "var(--primary)",
              }}
            />

            <span
              style={{
                fontFamily: "'Space Mono', monospace",
                fontSize: 11,
                color: "var(--primary)",
                letterSpacing: "0.15em",
              }}
            >
              19 DECEMBER 2026 · KIRINYAGA
            </span>
          </div>

          <h1
            style={{
              fontFamily: "'Anton', sans-serif",
              letterSpacing: "0.04em",
              lineHeight: 0.92,
              color: "var(--foreground)",
            }}
            className="text-7xl md:text-9xl mb-2"
          >
            BUSH
          </h1>

          <h1
            className="text-7xl md:text-9xl mb-2 flex items-center justify-center gap-4"
            style={{
              fontFamily: "'Anton', sans-serif",
              letterSpacing: "0.04em",
              lineHeight: 0.92,
              color: "var(--primary)",
            }}
          >
            N
            <span
              style={{
                fontSize: "0.6em",
                color: "var(--accent)",
              }}
            >
              ✦
            </span>
            BEAT
          </h1>

          <h1
            className="text-6xl md:text-8xl mb-8"
            style={{
              fontFamily: "'Anton', sans-serif",
              letterSpacing: "0.06em",
              lineHeight: 0.92,
              color: "var(--foreground)",
            }}
          >
            FEST
          </h1>

          <div className="flex items-center justify-center gap-3 mb-3">
            <div
              className="flex-1 max-w-[100px] h-px"
              style={{
                background: "var(--primary)",
                opacity: 0.4,
              }}
            />

            <p
              style={{
                fontFamily: "'Space Mono', monospace",
                fontSize: 13,
                color: "var(--muted-foreground)",
                letterSpacing: "0.2em",
              }}
            >
              FEATURING
            </p>

            <div
              className="flex-1 max-w-[100px] h-px"
              style={{
                background: "var(--primary)",
                opacity: 0.4,
              }}
            />
          </div>

          <p
            style={{
              fontFamily: "'Anton', sans-serif",
              fontSize: 52,
              color: "var(--primary)",
              letterSpacing: "0.08em",
              lineHeight: 1,
            }}
            className="md:text-7xl"
          >
            DJ QUAN
          </p>

          <p
            style={{
              fontFamily: "'Nunito', sans-serif",
              fontSize: 14,
              color: "var(--muted-foreground)",
              marginTop: 8,
            }}
          >
            LIVE · NJUKIINI FOREST LODGE · KIRINYAGA
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mt-10">
            <button
              onClick={() => setModal("advance")}
              className="flex items-center gap-3 px-8 py-4 rounded-xl font-bold text-lg transition-all hover:brightness-110 active:scale-95 w-full sm:w-auto"
              style={{
                background: "var(--primary)",
                color: "var(--primary-foreground)",
                fontFamily: "'Anton', sans-serif",
                fontSize: 20,
                letterSpacing: "0.08em",
              }}
            >
              <Ticket size={20} />
              ADVANCE — KSh 300
            </button>

            <a
              href="#tickets"
              className="flex items-center justify-center gap-3 px-8 py-4 rounded-xl font-bold text-lg transition-all hover:opacity-80 active:scale-95 w-full sm:w-auto"
              style={{
                background: "transparent",
                color: "var(--foreground)",
                fontFamily: "'Anton', sans-serif",
                fontSize: 20,
                letterSpacing: "0.08em",
                border: "2px solid rgba(237,232,212,0.3)",
              }}
            >
              GATE — KSh 500
            </a>
          </div>

          <p
            style={{
              fontSize: 12,
              color: "var(--muted-foreground)",
              marginTop: 12,
              fontFamily: "'Space Mono', monospace",
            }}
          >
            ↓ Save KSh 200 by booking in advance ↓
          </p>
        </div>

        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce">
          <ChevronDown
            size={24}
            style={{
              color: "var(--muted-foreground)",
            }}
          />
        </div>
      </section>

      {/* COUNTDOWN */}
      <section
        className="py-16 px-4"
        style={{
          background: "var(--card)",
          borderTop: "1px solid var(--border)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div className="max-w-3xl mx-auto text-center">
          <p
            style={{
              fontFamily: "'Space Mono', monospace",
              fontSize: 11,
              color: "var(--muted-foreground)",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              marginBottom: 16,
            }}
          >
            Countdown to the fest
          </p>

          <CountdownBlock />

          <div
            className="flex items-center justify-center gap-4 mt-8 flex-wrap text-sm"
            style={{
              color: "var(--muted-foreground)",
              fontFamily: "'Space Mono', monospace",
            }}
          >
            <div className="flex items-center gap-2">
              <Calendar
                size={14}
                style={{
                  color: "var(--primary)",
                }}
              />
              19 December 2026
            </div>

            <div className="flex items-center gap-2">
              <Clock
                size={14}
                style={{
                  color: "var(--primary)",
                }}
              />
              Gates open 4:00 PM
            </div>

            <div className="flex items-center gap-2">
              <MapPin
                size={14}
                style={{
                  color: "var(--primary)",
                }}
              />
              Njukiini Forest Lodge
            </div>
          </div>
        </div>
      </section>

      {/* LINEUP */}
      <section className="py-20 px-4">
        <div className="max-w-5xl mx-auto">
          <p
            style={{
              fontFamily: "'Space Mono', monospace",
              fontSize: 11,
              color: "var(--primary)",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Headline Act
          </p>

          <h2
            style={{
              fontFamily: "'Anton', sans-serif",
              fontSize: 52,
              color: "var(--foreground)",
              letterSpacing: "0.04em",
              marginBottom: 40,
            }}
          >
            THE LINEUP
          </h2>

          <div
            className="rounded-2xl overflow-hidden"
            style={{
              border: "1px solid var(--border)",
            }}
          >
            <div className="relative h-72 bg-green-950 overflow-hidden">
              <img
                src="https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=1200&h=500&fit=crop&auto=format"
                alt="DJ performing live"
                className="w-full h-full object-cover opacity-60"
              />

              <div
                className="absolute inset-0"
                style={{
                  background:
                    "linear-gradient(to right, rgba(10,26,7,0.92) 40%, rgba(10,26,7,0.2) 100%)",
                }}
              />

              <div className="absolute inset-0 flex flex-col justify-center px-10">
                <div
                  className="inline-flex items-center gap-2 px-3 py-1 rounded-full mb-4 w-fit"
                  style={{
                    background: "var(--accent)",
                  }}
                >
                  <Zap
                    size={12}
                    style={{
                      color: "white",
                    }}
                  />

                  <span
                    style={{
                      fontFamily: "'Space Mono', monospace",
                      fontSize: 10,
                      color: "white",
                      letterSpacing: "0.15em",
                    }}
                  >
                    HEADLINER
                  </span>
                </div>

                <h3
                  style={{
                    fontFamily: "'Anton', sans-serif",
                    fontSize: 64,
                    color: "var(--primary)",
                    letterSpacing: "0.06em",
                    lineHeight: 1,
                  }}
                >
                  DJ QUAN
                </h3>

                <p
                  style={{
                    fontFamily: "'Space Mono', monospace",
                    fontSize: 12,
                    color: "var(--muted-foreground)",
                    marginTop: 8,
                    letterSpacing: "0.1em",
                  }}
                >
                  AFROBEATS · HOUSE · AFRO-FUSION
                </p>

                <p
                  style={{
                    fontFamily: "'Nunito', sans-serif",
                    fontSize: 14,
                    color: "var(--foreground)",
                    marginTop: 8,
                    maxWidth: 380,
                    opacity: 0.85,
                  }}
                >
                  Kenya's hottest DJ brings the forest to life. DJ QUAN fuses
                  Afrobeats, deep house, and Afro-fusion for a set you won't
                  forget under the Kirinyaga stars.
                </p>

                <p
                  style={{
                    fontFamily: "'Space Mono', monospace",
                    fontSize: 12,
                    color: "var(--primary)",
                    marginTop: 10,
                    letterSpacing: "0.1em",
                  }}
                >
                  STAGE TIME — 8:00 PM ONWARDS
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* TICKETS */}
      <section
        id="tickets"
        className="py-20 px-4"
        style={{
          background: "var(--card)",
          borderTop: "1px solid var(--border)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div className="max-w-4xl mx-auto">
          <p
            style={{
              fontFamily: "'Space Mono', monospace",
              fontSize: 11,
              color: "var(--primary)",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Secure your spot
          </p>

          <h2
            style={{
              fontFamily: "'Anton', sans-serif",
              fontSize: 52,
              color: "var(--foreground)",
              letterSpacing: "0.04em",
              marginBottom: 12,
            }}
          >
            TICKETS
          </h2>

          <p
            style={{
              fontFamily: "'Nunito', sans-serif",
              fontSize: 15,
              color: "var(--muted-foreground)",
              marginBottom: 40,
            }}
          >
            Advance tickets sell fast. Book now and save KSh 200.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Advance */}
            <div
              className="rounded-2xl overflow-hidden"
              style={{
                border: "2px solid var(--primary)",
              }}
            >
              <div
                className="px-6 py-4 flex items-center justify-between"
                style={{
                  background: "rgba(200,255,0,0.08)",
                }}
              >
                <div>
                  <p
                    style={{
                      fontFamily: "'Anton', sans-serif",
                      fontSize: 26,
                      color: "var(--primary)",
                      letterSpacing: "0.06em",
                    }}
                  >
                    ADVANCE
                  </p>

                  <p
                    style={{
                      fontFamily: "'Space Mono', monospace",
                      fontSize: 11,
                      color: "var(--muted-foreground)",
                    }}
                  >
                    Book before the day
                  </p>
                </div>

                <div className="text-right">
                  <p
                    style={{
                      fontFamily: "'Anton', sans-serif",
                      fontSize: 40,
                      color: "var(--primary)",
                      lineHeight: 1,
                    }}
                  >
                    300
                  </p>

                  <p
                    style={{
                      fontFamily: "'Space Mono', monospace",
                      fontSize: 11,
                      color: "var(--muted-foreground)",
                    }}
                  >
                    KSh / person
                  </p>
                </div>
              </div>

              <div className="px-6 py-5">
                <ul className="flex flex-col gap-2 mb-6">
                  {[
                    "Full event access",
                    "Unique QR ticket once payment is confirmed",
                    "Save KSh 200 vs gate price",
                    "Pay by M-Pesa Send Money",
                  ].map((f) => (
                    <li key={f} className="flex items-center gap-2">
                      <div
                        className="w-4 h-4 rounded-full flex items-center justify-center shrink-0"
                        style={{
                          background: "rgba(200,255,0,0.2)",
                        }}
                      >
                        <div
                          className="w-1.5 h-1.5 rounded-full"
                          style={{
                            background: "var(--primary)",
                          }}
                        />
                      </div>

                      <span
                        style={{
                          fontSize: 14,
                          color: "var(--foreground)",
                          fontFamily: "'Nunito', sans-serif",
                        }}
                      >
                        {f}
                      </span>
                    </li>
                  ))}
                </ul>

                <button
                  onClick={() => setModal("advance")}
                  className="w-full py-4 rounded-xl font-bold tracking-wider transition-all hover:brightness-110 active:scale-95"
                  style={{
                    background: "var(--primary)",
                    color: "var(--primary-foreground)",
                    fontFamily: "'Anton', sans-serif",
                    fontSize: 20,
                    letterSpacing: "0.1em",
                  }}
                >
                  BUY ADVANCE — KSh 300
                </button>
              </div>
            </div>

            {/* Gate */}
            <div
              className="rounded-2xl overflow-hidden"
              style={{
                border: "1px solid var(--border)",
              }}
            >
              <div
                className="px-6 py-4 flex items-center justify-between"
                style={{
                  background: "rgba(255,85,0,0.06)",
                }}
              >
                <div>
                  <p
                    style={{
                      fontFamily: "'Anton', sans-serif",
                      fontSize: 26,
                      color: "var(--accent)",
                      letterSpacing: "0.06em",
                    }}
                  >
                    AT THE GATE
                  </p>

                  <p
                    style={{
                      fontFamily: "'Space Mono', monospace",
                      fontSize: 11,
                      color: "var(--muted-foreground)",
                    }}
                  >
                    Pay on arrival
                  </p>
                </div>

                <div className="text-right">
                  <p
                    style={{
                      fontFamily: "'Anton', sans-serif",
                      fontSize: 40,
                      color: "var(--accent)",
                      lineHeight: 1,
                    }}
                  >
                    500
                  </p>

                  <p
                    style={{
                      fontFamily: "'Space Mono', monospace",
                      fontSize: 11,
                      color: "var(--muted-foreground)",
                    }}
                  >
                    KSh / person
                  </p>
                </div>
              </div>

              <div className="px-6 py-5">
                <ul className="flex flex-col gap-2 mb-6">
                  {[
                    "Full event access",
                    "Subject to availability",
                    "Paid on arrival",
                    "No pre-booking needed",
                  ].map((f) => (
                    <li key={f} className="flex items-center gap-2">
                      <div
                        className="w-4 h-4 rounded-full flex items-center justify-center shrink-0"
                        style={{
                          background: "rgba(255,85,0,0.15)",
                        }}
                      >
                        <div
                          className="w-1.5 h-1.5 rounded-full"
                          style={{
                            background: "var(--accent)",
                          }}
                        />
                      </div>

                      <span
                        style={{
                          fontSize: 14,
                          color: "var(--foreground)",
                          fontFamily: "'Nunito', sans-serif",
                        }}
                      >
                        {f}
                      </span>
                    </li>
                  ))}
                </ul>

                <div
                  className="w-full py-4 rounded-xl text-center"
                  style={{
                    background: "var(--secondary)",
                    border: "1px solid var(--border)",
                    color: "var(--muted-foreground)",
                    fontFamily: "'Anton', sans-serif",
                    fontSize: 18,
                    letterSpacing: "0.1em",
                  }}
                >
                  AVAILABLE AT GATE · 19 DEC
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* VENUE */}
      <section className="py-20 px-4">
        <div className="max-w-5xl mx-auto">
          <p
            style={{
              fontFamily: "'Space Mono', monospace",
              fontSize: 11,
              color: "var(--primary)",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            The location
          </p>

          <h2
            style={{
              fontFamily: "'Anton', sans-serif",
              fontSize: 52,
              color: "var(--foreground)",
              letterSpacing: "0.04em",
              marginBottom: 40,
            }}
          >
            VENUE
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
            <div>
              <div className="rounded-2xl overflow-hidden h-64 bg-green-950">
                <img
                  src="https://images.unsplash.com/photo-1448375240586-882707db888b?w=800&h=500&fit=crop&auto=format"
                  alt="Njukiini Forest Lodge, Kirinyaga"
                  className="w-full h-full object-cover opacity-75"
                />
              </div>
            </div>

            <div className="flex flex-col gap-5">
              <div>
                <p
                  style={{
                    fontFamily: "'Anton', sans-serif",
                    fontSize: 32,
                    color: "var(--foreground)",
                    letterSpacing: "0.04em",
                    lineHeight: 1.1,
                  }}
                >
                  NJUKIINI FOREST LODGE
                </p>

                <p
                  style={{
                    fontFamily: "'Space Mono', monospace",
                    fontSize: 12,
                    color: "var(--primary)",
                    marginTop: 4,
                  }}
                >
                  KIRINYAGA COUNTY, KENYA
                </p>
              </div>

              <p
                style={{
                  fontFamily: "'Nunito', sans-serif",
                  fontSize: 15,
                  color: "var(--muted-foreground)",
                  lineHeight: 1.7,
                }}
              >
                Nestled in the indigenous forests at the foot of Mt. Kenya,
                Njukiini Forest Lodge offers a magical backdrop for an
                unforgettable night. Expect cool forest air, open skies, and
                the sounds of nature mixed with DJ QUAN's electric set.
              </p>

              {([
                [Trees, "Indigenous forest setting · Mt. Kenya foothills"],
                [MapPin, "Off Sagana–Karatina Road, Kirinyaga County"],
                [Clock, "Gates open 4:00 PM · Event runs until late"],
              ] as Array<[typeof Trees, string]>).map(([Icon, text]) => (
                <div
                  key={text}
                  className="flex items-start gap-3"
                >
                  <Icon
                    size={16}
                    style={{
                      color: "var(--primary)",
                      marginTop: 2,
                      flexShrink: 0,
                    }}
                  />

                  <p
                    style={{
                      fontSize: 14,
                      color: "var(--foreground)",
                      fontFamily: "'Nunito', sans-serif",
                    }}
                  >
                    {text}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section
        className="py-20 px-4"
        style={{
          background: "var(--card)",
          borderTop: "1px solid var(--border)",
        }}
      >
        <div className="max-w-3xl mx-auto">
          <p
            style={{
              fontFamily: "'Space Mono', monospace",
              fontSize: 11,
              color: "var(--primary)",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Got questions?
          </p>

          <h2
            style={{
              fontFamily: "'Anton', sans-serif",
              fontSize: 52,
              color: "var(--foreground)",
              letterSpacing: "0.04em",
              marginBottom: 40,
            }}
          >
            FAQ
          </h2>

          <div className="flex flex-col gap-2">
            {faqs.map(([q, a], i) => (
              <div
                key={i}
                className="rounded-xl overflow-hidden"
                style={{
                  border: "1px solid var(--border)",
                }}
              >
                <button
                  onClick={() =>
                    setFaqOpen(faqOpen === i ? null : i)
                  }
                  className="w-full flex items-center justify-between px-5 py-4 text-left transition-colors hover:opacity-80"
                  style={{
                    background:
                      faqOpen === i
                        ? "rgba(200,255,0,0.05)"
                        : "var(--secondary)",
                  }}
                >
                  <p
                    style={{
                      fontSize: 15,
                      fontWeight: 700,
                      color: "var(--foreground)",
                      fontFamily: "'Nunito', sans-serif",
                    }}
                  >
                    {q}
                  </p>

                  <ChevronDown
                    size={16}
                    style={{
                      color: "var(--muted-foreground)",
                      transform:
                        faqOpen === i
                          ? "rotate(180deg)"
                          : "none",
                      transition: "transform 0.2s",
                    }}
                  />
                </button>

                {faqOpen === i && (
                  <div
                    className="px-5 py-4"
                    style={{
                      background: "rgba(200,255,0,0.03)",
                      borderTop: "1px solid var(--border)",
                    }}
                  >
                    <p
                      style={{
                        fontSize: 14,
                        color: "var(--muted-foreground)",
                        fontFamily: "'Nunito', sans-serif",
                        lineHeight: 1.7,
                      }}
                    >
                      {a}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* HELPLINE */}
          <div
            className="mt-8 rounded-xl px-5 py-4 flex items-center gap-3"
            style={{
              background: "var(--secondary)",
              border: "1px solid var(--border)",
            }}
          >
            <Phone
              size={16}
              style={{ color: "var(--primary)", flexShrink: 0 }}
            />

            <p
              style={{
                fontSize: 14,
                color: "var(--muted-foreground)",
                fontFamily: "'Nunito', sans-serif",
              }}
            >
              Still need help? Call our helpline:{" "}
              <a
                href={HELPLINE_TEL}
                style={{
                  color: "var(--primary)",
                  fontFamily: "'Space Mono', monospace",
                  fontWeight: 700,
                }}
              >
                {HELPLINE_DISPLAY}
              </a>
            </p>
          </div>
        </div>
      </section>

      {/* FOOTER CTA */}
      <section className="py-20 px-4 text-center relative overflow-hidden">
        <div className="absolute inset-0 bg-green-950">
          <img
            src="https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=1600&h=600&fit=crop&auto=format"
            alt="Festival crowd at night"
            className="w-full h-full object-cover opacity-30"
          />

          <div
            className="absolute inset-0"
            style={{
              background: "rgba(10,26,7,0.8)",
            }}
          />
        </div>

        <div className="relative z-10 max-w-2xl mx-auto">
          <p
            style={{
              fontFamily: "'Anton', sans-serif",
              fontSize: 56,
              color: "var(--primary)",
              letterSpacing: "0.04em",
              lineHeight: 1,
            }}
            className="md:text-7xl"
          >
            SEE YOU IN
            <br />
            THE FOREST
          </p>

          <p
            style={{
              fontFamily: "'Space Mono', monospace",
              fontSize: 13,
              color: "var(--muted-foreground)",
              marginTop: 12,
              marginBottom: 32,
            }}
          >
            19 DECEMBER 2026 · NJUKIINI FOREST LODGE · KIRINYAGA
          </p>

          <button
            onClick={() => setModal("advance")}
            className="inline-flex items-center gap-3 px-10 py-5 rounded-xl font-bold transition-all hover:brightness-110 active:scale-95"
            style={{
              background: "var(--primary)",
              color: "var(--primary-foreground)",
              fontFamily: "'Anton', sans-serif",
              fontSize: 22,
              letterSpacing: "0.1em",
            }}
          >
            <Ticket size={22} />
            GET ADVANCE TICKETS — KSh 300
          </button>
        </div>
      </section>

      {/* FOOTER */}
      <footer
        className="py-8 px-6 flex flex-col md:flex-row items-center justify-between gap-4"
        style={{
          borderTop: "1px solid var(--border)",
          background: "var(--card)",
        }}
      >
        <p
          style={{
            fontFamily: "'Anton', sans-serif",
            fontSize: 16,
            color: "var(--primary)",
            letterSpacing: "0.12em",
          }}
        >
          BUSH N BEAT FEST 2026
        </p>

        <p
          style={{
            fontFamily: "'Space Mono', monospace",
            fontSize: 11,
            color: "var(--muted-foreground)",
          }}
        >
          Njukiini Forest Lodge · Kirinyaga County · Kenya
        </p>

        <p
          style={{
            fontFamily: "'Space Mono', monospace",
            fontSize: 11,
            color: "var(--muted-foreground)",
          }}
        >
          Helpline:{" "}
          <a href={HELPLINE_TEL} style={{ color: "var(--primary)" }}>
            {HELPLINE_DISPLAY}
          </a>
        </p>
      </footer>

      {/* TICKET MODAL */}
      {modal && (
        <TicketModal
          type={modal}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

export default function App() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";

  if (path === "/admin") {
    return <Suspense fallback={<p className="p-6">Loading admin dashboard…</p>}><AdminDashboard /></Suspense>;
  }
  if (path === "/ticket") {
    return <Suspense fallback={<p className="p-6">Loading ticket…</p>}><TicketReceipt /></Suspense>;
  }
  return <HomePage />;
}