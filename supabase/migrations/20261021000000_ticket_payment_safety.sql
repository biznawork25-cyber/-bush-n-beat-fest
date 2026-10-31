CREATE TABLE IF NOT EXISTS public.order_phone_rate_limits (
  phone text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL
);

ALTER TABLE public.order_phone_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_phone_rate_limits FROM PUBLIC, anon, authenticated;

CREATE UNIQUE INDEX IF NOT EXISTS payments_checkout_request_id_unique
  ON public.payments (checkout_request_id)
  WHERE checkout_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.create_ticket_order(
  p_event_id uuid,
  p_ticket_type_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_quantity integer,
  p_booking_reference text,
  p_requires_payment boolean
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
  v_amount numeric;
  v_attempts integer;
  v_window_started_at timestamptz;
BEGIN
  IF p_quantity < 1 OR p_quantity > 10 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
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

  v_amount := v_ticket_type.price * p_quantity;
  IF v_amount < 1 OR v_amount <> trunc(v_amount) THEN
    RAISE EXCEPTION 'INVALID_TICKET_PRICE';
  END IF;

  IF v_ticket_type.available_quantity IS NOT NULL THEN
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
    status
  )
  VALUES (
    p_booking_reference,
    p_event_id,
    p_ticket_type_id,
    p_customer_name,
    p_customer_phone,
    p_quantity,
    v_amount,
    'PENDING'
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

CREATE OR REPLACE FUNCTION public.fail_ticket_order(
  p_order_id uuid,
  p_payment_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment public.payments%ROWTYPE;
  v_order public.orders%ROWTYPE;
BEGIN
  SELECT *
  INTO v_payment
  FROM public.payments
  WHERE id = p_payment_id
    AND order_id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND';
  END IF;

  IF v_payment.status <> 'PENDING' THEN
    RETURN;
  END IF;

  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;

  UPDATE public.payments
  SET status = 'FAILED',
      result_description = p_reason
  WHERE id = p_payment_id;

  UPDATE public.orders
  SET status = 'FAILED'
  WHERE id = p_order_id;

  UPDATE public.ticket_types
  SET available_quantity = available_quantity + v_order.quantity
  WHERE id = v_order.ticket_type_id
    AND available_quantity IS NOT NULL;
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
    SET status = 'PAID'
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

REVOKE ALL ON FUNCTION public.create_ticket_order(uuid, uuid, text, text, integer, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_ticket_order(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_daraja_payment(text, integer, text, text, numeric) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_ticket_order(uuid, uuid, text, text, integer, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_ticket_order(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_daraja_payment(text, integer, text, text, numeric) TO service_role;
