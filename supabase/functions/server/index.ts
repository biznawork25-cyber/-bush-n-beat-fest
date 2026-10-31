import { Hono, type Context } from "npm:hono";
import { cors } from "npm:hono/cors";
import { createClient } from "jsr:@supabase/supabase-js@2.49.8";

const HELPLINE = "0798 512 390";

const app = new Hono();

app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

// Local dev origins are always allowed; add your live site in the ALLOWED_ORIGINS secret.
const DEFAULT_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
];

function getAllowedOrigins(): string[] {
  const envValue = Deno.env.get("ALLOWED_ORIGINS");
  const configured = envValue
    ? envValue.split(",").map((origin) => origin.trim()).filter(Boolean)
    : [];

  return [...new Set([...DEFAULT_ORIGINS, ...configured])];
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) {
        return "*";
      }

      if (getAllowedOrigins().includes(origin)) {
        return origin;
      }

      console.warn(`CORS blocked origin: ${origin}. Add it to ALLOWED_ORIGINS.`);
      return "";
    },
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "x-client-info",
      "apikey",
      "x-supabase-api-version",
    ],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

const supabase = () =>
  createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || c.req.header("cf-connecting-ip") || "unknown";
}

// Returns a 429 response when the caller is over the limit, otherwise null.
// If the limiter itself fails we let the request through (availability over lockout).
async function rateLimit(
  c: Context,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<Response | null> {
  const { data, error } = await supabase().rpc("check_rate_limit", {
    p_key: `${bucket}:${clientIp(c)}`,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });

  if (error) {
    console.error("Rate limit check failed:", error);
    return null;
  }

  if (data && data.allowed === false) {
    c.header("Retry-After", String(data.retry_after_seconds ?? windowSeconds));
    return c.json(
      { error: "Too many requests. Please wait a moment and try again." },
      429,
    );
  }

  return null;
}

async function requireAdmin(c: Context): Promise<{ id: string; email: string } | null> {
  const authorization = c.req.header("Authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const allowedEmail = Deno.env.get("ADMIN_EMAIL")?.trim().toLowerCase();

  if (!token || !allowedEmail) {
    return null;
  }

  const { data, error } = await supabase().auth.getUser(token);
  const email = data.user?.email?.toLowerCase();

  if (error || !data.user || email !== allowedEmail) {
    return null;
  }

  return { id: data.user.id, email };
}

function adminUnauthorized(c: Context): Response {
  return c.json({ error: "Admin authentication required" }, 401);
}

function normalizePhone(phone: string): string {
  let value = phone.replace(/[\s+\-()]/g, "");

  if (value.startsWith("0")) {
    value = "254" + value.slice(1);
  }

  if (!/^254[17]\d{8}$/.test(value)) {
    throw new Error(
      "Enter a valid Kenyan phone number, such as 0712345678",
    );
  }

  return value;
}

// Every admin route is rate-limited BEFORE any authentication work happens.
app.use("/admin/*", async (c, next) => {
  const limited = await rateLimit(c, "admin", 120, 60);
  if (limited) return limited;
  await next();
});

app.get("/", (c) => {
  return c.json({
    status: "ok",
    service: "BUSH N BEAT server",
  });
});

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "BUSH N BEAT server",
  });
});

// ─── PUBLIC: ticket page data ────────────────────────────────────────────────

app.post("/ticket-status", async (c) => {
  try {
    const limited = await rateLimit(c, "status", 300, 60);
    if (limited) return limited;

    const body = await c.req.json();
    const token = body?.token;

    if (typeof token !== "string" || token.length < 32 || token.length > 200) {
      return c.json({ error: "Invalid ticket link" }, 400);
    }

    const db = supabase();
    const { data: order, error } = await db
      .from("orders")
      .select(
        "id, booking_reference, customer_name, quantity, amount, status, event_id, ticket_type_id",
      )
      .eq("receipt_token_hash", await sha256(token))
      .maybeSingle();

    if (error) {
      console.error("Could not look up ticket receipt:", error);
      return c.json({ error: "Could not load ticket details" }, 500);
    }

    if (!order) {
      return c.json({ error: "Ticket link not found" }, 404);
    }

    const [eventResult, ticketTypeResult, paymentResult] = await Promise.all([
      db.from("events").select("name, venue, event_date").eq("id", order.event_id).single(),
      db.from("ticket_types").select("name").eq("id", order.ticket_type_id).single(),
      db.from("payments").select("status, mpesa_receipt_number").eq("order_id", order.id).maybeSingle(),
    ]);

    if (eventResult.error || ticketTypeResult.error || paymentResult.error) {
      console.error("Could not load order details:", {
        eventError: eventResult.error,
        ticketTypeError: ticketTypeResult.error,
        paymentError: paymentResult.error,
      });
      return c.json({ error: "Could not load ticket details" }, 500);
    }

    const payment = paymentResult.data;

    const response: Record<string, unknown> = {
      bookingReference: order.booking_reference,
      customerName: order.customer_name,
      quantity: order.quantity,
      amount: order.amount,
      status: order.status,
      event: eventResult.data,
      ticketType: ticketTypeResult.data?.name,
      paymentRequired: Boolean(payment),
      codeSubmitted: Boolean(payment?.mpesa_receipt_number),
      tickets: [],
    };

    if (order.status === "PENDING" && payment) {
      response.payTo = Deno.env.get("MANUAL_PAYMENT_NUMBER")?.trim() ?? null;
      response.payToName = Deno.env.get("MANUAL_PAYMENT_NAME")?.trim() ?? null;
    }

    if (order.status === "PAID") {
      const { data: tickets, error: ticketsError } = await db
        .from("tickets")
        .select("ticket_code, status, checked_in_at")
        .eq("order_id", order.id);

      if (ticketsError) {
        console.error("Could not load tickets:", ticketsError);
        return c.json({ error: "Could not load ticket details" }, 500);
      }

      response.tickets = tickets ?? [];
    }

    return c.json(response);
  } catch (error) {
    console.error("Ticket receipt lookup failed:", error);
    return c.json({ error: "Could not load ticket details" }, 500);
  }
});

// ─── PUBLIC: customer submits their M-Pesa code ──────────────────────────────

app.post("/submit-payment", async (c) => {
  try {
    const limited = await rateLimit(c, "submit", 30, 900);
    if (limited) return limited;

    const body = await c.req.json();
    const token = body?.token;
    const code = typeof body?.mpesaCode === "string"
      ? body.mpesaCode.replace(/\s/g, "").toUpperCase()
      : "";

    if (typeof token !== "string" || token.length < 32 || token.length > 200) {
      return c.json({ error: "Invalid ticket link" }, 400);
    }

    if (!/^[A-Z0-9]{10}$/.test(code)) {
      return c.json(
        {
          error:
            "Enter the 10-character M-Pesa code from your confirmation SMS (letters and numbers).",
        },
        400,
      );
    }

    const db = supabase();
    const { data: order, error: orderError } = await db
      .from("orders")
      .select("id")
      .eq("receipt_token_hash", await sha256(token))
      .maybeSingle();

    if (orderError) {
      console.error("Could not look up order:", orderError);
      return c.json({ error: "Could not save your code. Try again." }, 500);
    }

    if (!order) {
      return c.json({ error: "Ticket link not found" }, 404);
    }

    const { data, error } = await db.rpc("submit_manual_payment_code", {
      p_order_id: order.id,
      p_code: code,
    });

    if (error) {
      console.error("Submit payment code failed:", error);
      const message = error.message ?? "";
      if (message.includes("ORDER_NOT_PENDING")) {
        return c.json({ error: "This order is no longer waiting for payment." }, 409);
      }
      if (message.includes("TOO_MANY_ATTEMPTS")) {
        return c.json(
          { error: `Too many attempts. Please call the helpline: ${HELPLINE}` },
          429,
        );
      }
      if (message.includes("INVALID_CODE")) {
        return c.json({ error: "That M-Pesa code is not valid." }, 400);
      }
      return c.json({ error: "Could not save your code. Try again." }, 500);
    }

    if (data?.error === "CODE_ALREADY_USED") {
      return c.json(
        {
          error:
            `That M-Pesa code was already used on another order. Check it and try again, or call ${HELPLINE}.`,
        },
        409,
      );
    }

    return c.json({ status: "AWAITING_APPROVAL" });
  } catch (error) {
    console.error("Submit payment failed:", error);
    return c.json({ error: "Could not save your code. Try again." }, 500);
  }
});

// ─── ADMIN ───────────────────────────────────────────────────────────────────

app.get("/admin/events", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return adminUnauthorized(c);

  const { data, error } = await supabase()
    .from("events")
    .select("id, name, venue, event_date")
    .order("event_date", { ascending: false });

  if (error) {
    console.error("Could not load admin events:", error);
    return c.json({ error: "Could not load events" }, 500);
  }

  return c.json({ events: data ?? [] });
});

app.get("/admin/summary", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return adminUnauthorized(c);

  const eventId = c.req.query("eventId");
  if (!eventId) return c.json({ error: "Event is required" }, 400);

  const { data, error } = await supabase().rpc("admin_event_summary", {
    p_event_id: eventId,
  });

  if (error) {
    console.error("Could not load admin summary:", error);
    return c.json({ error: "Could not load event summary" }, 500);
  }

  return c.json(data);
});

app.get("/admin/pending-payments", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return adminUnauthorized(c);

  const eventId = c.req.query("eventId");
  if (!eventId) return c.json({ error: "Event is required" }, 400);

  const { data, error } = await supabase().rpc("admin_pending_payments", {
    p_event_id: eventId,
  });

  if (error) {
    console.error("Could not load pending payments:", error);
    return c.json({ error: "Could not load pending payments" }, 500);
  }

  return c.json({ payments: data ?? [] });
});

app.post("/admin/payments/approve", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return adminUnauthorized(c);

  try {
    const body = await c.req.json();
    const paymentId = typeof body?.paymentId === "string" ? body.paymentId : "";
    if (!paymentId) return c.json({ error: "Payment is required" }, 400);

    const { data, error } = await supabase().rpc("admin_approve_manual_payment", {
      p_payment_id: paymentId,
      p_admin_user_id: admin.id,
    });

    if (error) {
      console.error("Approve payment failed:", error);
      const message = error.message ?? "";
      if (message.includes("NO_CODE_SUBMITTED")) {
        return c.json({ error: "The customer has not submitted an M-Pesa code yet." }, 409);
      }
      if (message.includes("PAYMENT_NOT_PENDING") || message.includes("ORDER_NOT_PENDING")) {
        return c.json({ error: "This payment was already handled. Refresh the list." }, 409);
      }
      if (message.includes("PAYMENT_NOT_FOUND")) {
        return c.json({ error: "Payment not found." }, 404);
      }
      return c.json({ error: "Could not approve this payment." }, 500);
    }

    return c.json(data);
  } catch (error) {
    console.error("Approve payment failed:", error);
    return c.json({ error: "Could not approve this payment." }, 500);
  }
});

app.post("/admin/payments/reject", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return adminUnauthorized(c);

  try {
    const body = await c.req.json();
    const paymentId = typeof body?.paymentId === "string" ? body.paymentId : "";
    if (!paymentId) return c.json({ error: "Payment is required" }, 400);

    const db = supabase();
    const { data: payment, error: lookupError } = await db
      .from("payments")
      .select("id, order_id, status")
      .eq("id", paymentId)
      .maybeSingle();

    if (lookupError) {
      console.error("Could not look up payment:", lookupError);
      return c.json({ error: "Could not reject this payment." }, 500);
    }

    if (!payment) return c.json({ error: "Payment not found." }, 404);

    if (payment.status !== "PENDING") {
      return c.json({ error: "This payment was already handled. Refresh the list." }, 409);
    }

    const { error } = await db.rpc("fail_ticket_order", {
      p_order_id: payment.order_id,
      p_payment_id: payment.id,
      p_reason: "Rejected by admin: payment could not be verified",
    });

    if (error) {
      console.error("Reject payment failed:", error);
      return c.json({ error: "Could not reject this payment." }, 500);
    }

    return c.json({ status: "FAILED" });
  } catch (error) {
    console.error("Reject payment failed:", error);
    return c.json({ error: "Could not reject this payment." }, 500);
  }
});

app.post("/admin/promoters", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return adminUnauthorized(c);

  try {
    const body = await c.req.json();
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const eventId = typeof body?.eventId === "string" ? body.eventId : "";

    if (!name || name.length > 100 || !eventId) {
      return c.json({ error: "Enter a promoter name and select an event" }, 400);
    }

    const baseCode = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "PROMO";
    const referralCode = `${baseCode}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
    const { data, error } = await supabase()
      .from("promoters")
      .insert({
        event_id: eventId,
        name,
        referral_code: referralCode,
        commission_rate: 5,
      })
      .select("id, name, referral_code, commission_rate, is_active")
      .single();

    if (error) {
      console.error("Could not create promoter:", error);
      return c.json({ error: "Could not create promoter" }, 500);
    }

    return c.json({ promoter: data }, 201);
  } catch (error) {
    console.error("Promoter creation failed:", error);
    return c.json({ error: "Could not create promoter" }, 500);
  }
});

app.post("/admin/events", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return adminUnauthorized(c);

  try {
    const body = await c.req.json();
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const venue = typeof body?.venue === "string" ? body.venue.trim() : "";
    const eventDate = typeof body?.eventDate === "string" ? body.eventDate : "";
    const advancePrice = Number(body?.advancePrice);
    const gatePrice = Number(body?.gatePrice);

    if (
      !name || name.length > 150 ||
      !venue || venue.length > 200 ||
      !eventDate || !Number.isFinite(Date.parse(eventDate)) ||
      !Number.isInteger(advancePrice) || advancePrice < 1 ||
      !Number.isInteger(gatePrice) || gatePrice < 1
    ) {
      return c.json({ error: "Enter valid event details and ticket prices" }, 400);
    }

    const { data, error } = await supabase().rpc("create_event_edition", {
      p_name: name,
      p_venue: venue,
      p_event_date: eventDate,
      p_advance_price: advancePrice,
      p_gate_price: gatePrice,
    });

    if (error) {
      console.error("Could not create event edition:", error);
      return c.json({ error: "Could not create event edition" }, 500);
    }

    return c.json({ eventId: data }, 201);
  } catch (error) {
    console.error("Event edition creation failed:", error);
    return c.json({ error: "Could not create event edition" }, 500);
  }
});

app.post("/admin/check-in", async (c) => {
  const admin = await requireAdmin(c);
  if (!admin) return adminUnauthorized(c);

  try {
    const body = await c.req.json();
    const ticketCode = typeof body?.ticketCode === "string"
      ? body.ticketCode.trim()
      : "";

    if (!ticketCode || ticketCode.length > 100) {
      return c.json({ error: "Enter a valid ticket code" }, 400);
    }

    const { data, error } = await supabase().rpc("admin_check_in_ticket", {
      p_ticket_code: ticketCode,
      p_admin_user_id: admin.id,
    });

    if (error) {
      console.error("Ticket check-in failed:", error);
      return c.json({ error: "Could not verify ticket" }, 500);
    }

    return c.json(data);
  } catch (error) {
    console.error("Ticket check-in failed:", error);
    return c.json({ error: "Could not verify ticket" }, 500);
  }
});

// ─── PUBLIC: create order (Advance tickets only) ─────────────────────────────

app.post("/create-order", async (c) => {
  try {
    const limited = await rateLimit(c, "order", 30, 900);
    if (limited) return limited;

    const body = await c.req.json();

    const {
      eventId,
      ticketTypeId,
      customerName,
      customerPhone,
      quantity,
      receiptTokenHash,
      referralCode,
    } = body;

    if (
      !eventId ||
      !ticketTypeId ||
      !customerName ||
      !customerPhone ||
      typeof receiptTokenHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(receiptTokenHash) ||
      quantity === undefined ||
      quantity === null ||
      quantity === ""
    ) {
      return c.json({ error: "Missing required order information" }, 400);
    }

    if (
      typeof customerName !== "string" ||
      !customerName.trim() ||
      customerName.length > 150
    ) {
      return c.json({ error: "Enter a valid customer name" }, 400);
    }

    let phone: string;

    try {
      phone = normalizePhone(String(customerPhone));
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error
            ? error.message
            : "Invalid phone number",
        },
        400,
      );
    }

    const ticketQuantity = Number(quantity);

    if (
      !Number.isInteger(ticketQuantity) ||
      ticketQuantity < 1 ||
      ticketQuantity > 10
    ) {
      return c.json({ error: "Quantity must be between 1 and 10" }, 400);
    }

    const db = supabase();

    const { data: event, error: eventError } = await db
      .from("events")
      .select("id, name, venue, event_date")
      .eq("id", eventId)
      .single();

    if (eventError || !event) {
      return c.json({ error: "Event not found" }, 404);
    }

    const { data: ticketType, error: ticketError } = await db
      .from("ticket_types")
      .select(
        "id, event_id, name, price, description, available_quantity, is_active",
      )
      .eq("id", ticketTypeId)
      .eq("event_id", eventId)
      .single();

    if (ticketError || !ticketType) {
      return c.json({ error: "Ticket type not found" }, 404);
    }

    if (!ticketType.is_active) {
      return c.json({ error: "This ticket type is no longer available" }, 400);
    }

    // Gate tickets are paid at the entrance, so they are never booked online.
    if (ticketType.name.trim().toLowerCase() === "gate") {
      return c.json(
        { error: "Gate tickets are paid at the entrance. No booking is needed." },
        400,
      );
    }

    const amount = Number(ticketType.price) * ticketQuantity;

    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 1) {
      return c.json({ error: "The ticket price is invalid" }, 400);
    }

    // Refuse before creating anything if the payment number is not configured.
    if (!Deno.env.get("MANUAL_PAYMENT_NUMBER")?.trim()) {
      console.error("MANUAL_PAYMENT_NUMBER secret is not set");
      return c.json(
        { error: `Ticket payments are not available right now. Please call ${HELPLINE}.` },
        503,
      );
    }

    // Free up stock held by unpaid orders that were abandoned.
    const { error: releaseError } = await db.rpc("release_stale_orders");
    if (releaseError) {
      console.error("Could not release stale orders:", releaseError);
    }

    const bookingReference = `BNB-${crypto.randomUUID()
      .replaceAll("-", "")
      .slice(0, 10)
      .toUpperCase()}`;

    const { data: order, error: orderError } = await db.rpc(
      "create_ticket_order",
      {
        p_event_id: eventId,
        p_ticket_type_id: ticketTypeId,
        p_customer_name: customerName.trim(),
        p_customer_phone: phone,
        p_quantity: ticketQuantity,
        p_booking_reference: bookingReference,
        p_requires_payment: true,
        p_receipt_token_hash: receiptTokenHash,
        p_referral_code: typeof referralCode === "string" ? referralCode : null,
      },
    );

    if (order?.rate_limited) {
      c.header("Retry-After", String(order.retry_after_seconds ?? 900));
      return c.json({ error: "Too many order attempts. Try again later." }, 429);
    }

    if (orderError || !order) {
      console.error("Order creation error:", orderError);
      if (orderError?.message.includes("TICKET_UNAVAILABLE")) {
        return c.json({ error: "Not enough tickets available" }, 409);
      }
      if (orderError?.message.includes("INVALID_REFERRAL")) {
        return c.json({ error: "This promoter referral link is not valid" }, 400);
      }

      return c.json({ error: "Failed to create order" }, 500);
    }

    if (!order.payment_id) {
      console.error("Payment record missing for order:", order.order_id);
      return c.json({ error: "Could not create payment record" }, 500);
    }

    return c.json({
      success: true,
      message: "Order created. Pay by M-Pesa Send Money, then enter your M-Pesa code.",
      order: {
        id: order.order_id,
        bookingReference: order.booking_reference,
        customerName: customerName.trim(),
        customerPhone: phone,
        quantity: ticketQuantity,
        amount: order.amount,
        status: "PENDING",
      },
      payment: {
        id: order.payment_id,
        status: "PENDING",
      },
      event: {
        id: event.id,
        name: event.name,
        venue: event.venue,
      },
      ticket: {
        id: ticketType.id,
        name: ticketType.name,
        price: ticketType.price,
      },
    });
  } catch (error) {
    console.error("Create order error:", error);

    return c.json(
      { error: "Something went wrong while creating the order" },
      500,
    );
  }
});

Deno.serve(async (req) => {
  const url = new URL(req.url);

  console.log("REQUEST:", req.method, url.pathname);

  if (url.pathname === "/server" || url.pathname.startsWith("/server/")) {
    url.pathname = url.pathname.slice("/server".length) || "/";
    return app.fetch(new Request(url, req));
  }

  return app.fetch(req);
});