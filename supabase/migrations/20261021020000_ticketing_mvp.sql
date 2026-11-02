ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS receipt_token_hash text,
  ADD COLUMN IF NOT EXISTS promoter_id uuid,
  ADD COLUMN IF NOT EXISTS referral_code text,
  ADD COLUMN IF NOT EXISTS commission_rate numeric(5, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission_amount numeric(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS checked_in_at timestamptz,
  ADD COLUMN IF NOT EXISTS checked_in_by uuid;

CREATE UNIQUE INDEX IF NOT EXISTS orders_receipt_token_hash_unique
  ON public.orders (receipt_token_hash)
  WHERE receipt_token_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tickets_ticket_code_unique
  ON public.tickets (ticket_code);

CREATE INDEX IF NOT EXISTS orders_event_status_idx
  ON public.orders (event_id, status);

CREATE INDEX IF NOT EXISTS orders_promoter_status_idx
  ON public.orders (promoter_id, status)
  WHERE promoter_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.promoters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  name text NOT NULL,
  referral_code text NOT NULL UNIQUE,
  commission_rate numeric(5, 2) NOT NULL DEFAULT 5.00
    CHECK (commission_rate >= 0 AND commission_rate <= 100),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.promoters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.promoters FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'orders_promoter_id_fkey'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_promoter_id_fkey
      FOREIGN KEY (promoter_id) REFERENCES public.promoters(id)
      ON DELETE SET NULL;
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.create_ticket_order(
  uuid, uuid, text, text, integer, text, boolean
);

CREATE OR REPLACE FUNCTION public.create_ticket_order(
  p_event_id uuid,
  p_ticket_type_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_quantity integer,
  p_booking_reference text,
  p_requires_payment boolean,
  p_receipt_token_hash text,
  p_referral_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket_type public.ticket_types%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_payment public.payments%ROWTYPE;
  v_promoter public.promoters%ROWTYPE;
  v_amount numeric;
  v_attempts integer;
  v_window_started_at timestamptz;
  v_referral_code text;
BEGIN
  IF p_quantity < 1 OR p_quantity > 10 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;

  IF p_receipt_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_RECEIPT_TOKEN';
  END IF;

  INSERT INTO public.order_phone_rate_limits (
    phone,
    window_started_at,
    attempts
  )
  VALUES (p_customer_phone, now(), 1)
  ON CONFLICT (phone) DO UPDATE
  SET window_started_at = CASE
        WHEN public.order_phone_rate_limits.window_started_at <= now() - interval '15 minutes'
          THEN now()
        ELSE public.order_phone_rate_limits.window_started_at
      END,
      attempts = CASE
        WHEN public.order_phone_rate_limits.window_started_at <= now() - interval '15 minutes'
          THEN 1
        ELSE public.order_phone_rate_limits.attempts + 1
      END
  RETURNING attempts, window_started_at
  INTO v_attempts, v_window_started_at;

  IF v_attempts > 5 THEN
    RETURN jsonb_build_object(
      'rate_limited', true,
      'retry_after_seconds',
      greatest(
        1,
        ceil(extract(epoch FROM (v_window_started_at + interval '15 minutes' - now())))::integer
      )
    );
  END IF;

  SELECT *
  INTO v_ticket_type
  FROM public.ticket_types
  WHERE id = p_ticket_type_id
    AND event_id = p_event_id
    AND is_active = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TICKET_UNAVAILABLE';
  END IF;

  IF v_ticket_type.available_quantity IS NOT NULL
    AND v_ticket_type.available_quantity < p_quantity THEN
    RAISE EXCEPTION 'TICKET_UNAVAILABLE';
  END IF;

  IF p_referral_code IS NOT NULL AND btrim(p_referral_code) <> '' THEN
    v_referral_code := upper(btrim(p_referral_code));

    SELECT *
    INTO v_promoter
    FROM public.promoters
    WHERE referral_code = v_referral_code
      AND event_id = p_event_id
      AND is_active = true;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'INVALID_REFERRAL';
    END IF;
  END IF;

  v_amount := v_ticket_type.price * p_quantity;
  IF v_amount < 1 OR v_amount <> trunc(v_amount) THEN
    RAISE EXCEPTION 'INVALID_TICKET_PRICE';
  END IF;

  IF p_requires_payment AND v_ticket_type.available_quantity IS NOT NULL THEN
    UPDATE public.ticket_types
    SET available_quantity = available_quantity - p_quantity
    WHERE id = p_ticket_type_id;
  END IF;

  INSERT INTO public.orders (
    booking_reference,
    event_id,
    ticket_type_id,
    customer_name,
    customer_phone,
    quantity,
    amount,
    status,
    receipt_token_hash,
    promoter_id,
    referral_code,
    commission_rate
  )
  VALUES (
    p_booking_reference,
    p_event_id,
    p_ticket_type_id,
    p_customer_name,
    p_customer_phone,
    p_quantity,
    v_amount,
    'PENDING',
    p_receipt_token_hash,
    v_promoter.id,
    v_referral_code,
    coalesce(v_promoter.commission_rate, 0)
  )
  RETURNING * INTO v_order;

  IF p_requires_payment THEN
    INSERT INTO public.payments (order_id, amount, phone, status)
    VALUES (v_order.id, v_amount, p_customer_phone, 'PENDING')
    RETURNING * INTO v_payment;
  END IF;

  RETURN jsonb_build_object(
    'order_id', v_order.id,
    'payment_id', v_payment.id,
    'booking_reference', v_order.booking_reference,
    'amount', v_amount
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_daraja_payment(
  p_checkout_request_id text,
  p_result_code integer,
  p_result_description text,
  p_receipt_number text,
  p_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_ticket_type public.ticket_types%ROWTYPE;
BEGIN
  SELECT *
  INTO v_payment
  FROM public.payments
  WHERE checkout_request_id = p_checkout_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND';
  END IF;

  IF v_payment.status = 'PAID' THEN
    RETURN jsonb_build_object('status', 'PAID');
  END IF;

  IF v_payment.status <> 'PENDING' THEN
    RETURN jsonb_build_object('status', v_payment.status);
  END IF;

  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = v_payment.order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  IF p_result_code = 0 THEN
    IF p_amount IS NULL OR p_amount <> v_payment.amount THEN
      RAISE EXCEPTION 'PAYMENT_AMOUNT_MISMATCH';
    END IF;

    SELECT *
    INTO v_ticket_type
    FROM public.ticket_types
    WHERE id = v_order.ticket_type_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'TICKET_TYPE_NOT_FOUND';
    END IF;

    INSERT INTO public.tickets (
      order_id,
      ticket_code,
      customer_name,
      customer_phone,
      ticket_type,
      status
    )
    SELECT
      v_order.id,
      'BNBT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)),
      v_order.customer_name,
      v_order.customer_phone,
      v_ticket_type.name,
      'VALID'
    FROM generate_series(1, v_order.quantity::integer);

    UPDATE public.payments
    SET status = 'PAID',
        result_code = p_result_code,
        result_description = p_result_description,
        mpesa_receipt_number = p_receipt_number
    WHERE id = v_payment.id;

    UPDATE public.orders
    SET status = 'PAID',
        commission_amount = round(v_order.amount * v_order.commission_rate / 100, 2)
    WHERE id = v_order.id;
  ELSE
    UPDATE public.payments
    SET status = 'FAILED',
        result_code = p_result_code,
        result_description = p_result_description
    WHERE id = v_payment.id;

    UPDATE public.orders
    SET status = 'FAILED'
    WHERE id = v_order.id;

    UPDATE public.ticket_types
    SET available_quantity = available_quantity + v_order.quantity
    WHERE id = v_order.ticket_type_id
      AND available_quantity IS NOT NULL;
  END IF;

  RETURN jsonb_build_object(
    'status',
    CASE WHEN p_result_code = 0 THEN 'PAID' ELSE 'FAILED' END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_event_summary(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event public.events%ROWTYPE;
  v_result jsonb;
BEGIN
  SELECT *
  INTO v_event
  FROM public.events
  WHERE id = p_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EVENT_NOT_FOUND';
  END IF;

  SELECT jsonb_build_object(
    'event', jsonb_build_object(
      'id', v_event.id,
      'name', v_event.name,
      'venue', v_event.venue,
      'eventDate', v_event.event_date
    ),
    'orders', (
      SELECT count(*)
      FROM public.orders o
      WHERE o.event_id = p_event_id
    ),
    'paidOrders', (
      SELECT count(*)
      FROM public.orders o
      WHERE o.event_id = p_event_id
        AND o.status = 'PAID'
    ),
    'revenue', coalesce((
      SELECT sum(o.amount)
      FROM public.orders o
      WHERE o.event_id = p_event_id
        AND o.status = 'PAID'
    ), 0),
    'commissionDue', coalesce((
      SELECT sum(o.commission_amount)
      FROM public.orders o
      WHERE o.event_id = p_event_id
        AND o.status = 'PAID'
    ), 0),
    'ticketsIssued', (
      SELECT count(*)
      FROM public.tickets t
      JOIN public.orders o ON o.id = t.order_id
      WHERE o.event_id = p_event_id
    ),
    'ticketsCheckedIn', (
      SELECT count(*)
      FROM public.tickets t
      JOIN public.orders o ON o.id = t.order_id
      WHERE o.event_id = p_event_id
        AND t.status = 'USED'
    ),
    'promoters', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'code', p.referral_code,
        'commissionRate', p.commission_rate,
        'isActive', p.is_active,
        'paidOrders', (
          SELECT count(*)
          FROM public.orders o
          WHERE o.promoter_id = p.id
            AND o.status = 'PAID'
        ),
        'revenue', coalesce((
          SELECT sum(o.amount)
          FROM public.orders o
          WHERE o.promoter_id = p.id
            AND o.status = 'PAID'
        ), 0),
        'commissionDue', coalesce((
          SELECT sum(o.commission_amount)
          FROM public.orders o
          WHERE o.promoter_id = p.id
            AND o.status = 'PAID'
        ), 0)
      ) ORDER BY p.name)
      FROM public.promoters p
      WHERE p.event_id = p_event_id
    ), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_check_in_ticket(
  p_ticket_code text,
  p_admin_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket public.tickets%ROWTYPE;
  v_order public.orders%ROWTYPE;
BEGIN
  SELECT *
  INTO v_ticket
  FROM public.tickets
  WHERE ticket_code = btrim(p_ticket_code)
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'NOT_FOUND');
  END IF;

  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = v_ticket.order_id;

  IF NOT FOUND OR v_order.status <> 'PAID' THEN
    RETURN jsonb_build_object('result', 'NOT_PAID');
  END IF;

  IF v_ticket.status <> 'VALID' THEN
    RETURN jsonb_build_object(
      'result', 'ALREADY_USED',
      'checkedInAt', v_ticket.checked_in_at
    );
  END IF;

  UPDATE public.tickets
  SET status = 'USED',
      checked_in_at = now(),
      checked_in_by = p_admin_user_id
  WHERE id = v_ticket.id;

  RETURN jsonb_build_object(
    'result', 'CHECKED_IN',
    'ticketType', v_ticket.ticket_type,
    'customerName', v_ticket.customer_name,
    'bookingReference', v_order.booking_reference
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_event_edition(
  p_name text,
  p_venue text,
  p_event_date timestamptz,
  p_advance_price numeric,
  p_gate_price numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_id uuid;
BEGIN
  IF btrim(p_name) = '' OR btrim(p_venue) = '' THEN
    RAISE EXCEPTION 'EVENT_NAME_AND_VENUE_REQUIRED';
  END IF;

  IF p_advance_price <= 0 OR p_gate_price <= 0 THEN
    RAISE EXCEPTION 'TICKET_PRICES_MUST_BE_POSITIVE';
  END IF;

  INSERT INTO public.events (name, venue, event_date)
  VALUES (btrim(p_name), btrim(p_venue), p_event_date)
  RETURNING id INTO v_event_id;

  INSERT INTO public.ticket_types (
    event_id,
    name,
    price,
    description,
    is_active,
    available_quantity
  )
  VALUES
    (v_event_id, 'Advance', p_advance_price, 'Advance admission', true, null),
    (v_event_id, 'Gate', p_gate_price, 'Pay on arrival', true, null);

  RETURN v_event_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_ticket_order(uuid, uuid, text, text, integer, text, boolean, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_daraja_payment(text, integer, text, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_event_summary(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_check_in_ticket(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_event_edition(text, text, timestamptz, numeric, numeric) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_ticket_order(uuid, uuid, text, text, integer, text, boolean, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_daraja_payment(text, integer, text, text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_event_summary(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_check_in_ticket(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_event_edition(text, text, timestamptz, numeric, numeric) TO service_role;
