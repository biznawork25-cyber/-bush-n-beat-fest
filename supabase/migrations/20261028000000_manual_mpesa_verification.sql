-- Manual M-Pesa verification: customer pays by Send Money, enters the M-Pesa code,
-- tickets are created only when the admin approves.

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS mpesa_receipt_number text,
  ADD COLUMN IF NOT EXISTS result_code integer,
  ADD COLUMN IF NOT EXISTS result_description text,
  ADD COLUMN IF NOT EXISTS code_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS code_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

-- One M-Pesa code can only back ONE live order. Rejected orders release their code.
CREATE UNIQUE INDEX IF NOT EXISTS payments_mpesa_code_active_unique
  ON public.payments (upper(mpesa_receipt_number))
  WHERE mpesa_receipt_number IS NOT NULL AND status IN ('PENDING', 'PAID');

CREATE OR REPLACE FUNCTION public.submit_manual_payment_code(
  p_order_id uuid,
  p_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_payment public.payments%ROWTYPE;
  v_code text := upper(btrim(p_code));
BEGIN
  IF v_code !~ '^[A-Z0-9]{10}$' THEN
    RAISE EXCEPTION 'INVALID_CODE';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;

  SELECT * INTO v_payment FROM public.payments WHERE order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_NOT_FOUND'; END IF;

  IF v_order.status <> 'PENDING' OR v_payment.status <> 'PENDING' THEN
    RAISE EXCEPTION 'ORDER_NOT_PENDING';
  END IF;

  IF v_payment.code_attempts >= 5 THEN
    RAISE EXCEPTION 'TOO_MANY_ATTEMPTS';
  END IF;

  UPDATE public.payments
  SET code_attempts = code_attempts + 1
  WHERE id = v_payment.id;

  BEGIN
    UPDATE public.payments
    SET mpesa_receipt_number = v_code,
        code_submitted_at = now()
    WHERE id = v_payment.id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('error', 'CODE_ALREADY_USED');
  END;

  RETURN jsonb_build_object('status', 'AWAITING_APPROVAL');
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_pending_payments(p_event_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'paymentId', p.id,
        'orderId', o.id,
        'bookingReference', o.booking_reference,
        'customerName', o.customer_name,
        'customerPhone', o.customer_phone,
        'quantity', o.quantity,
        'amount', p.amount,
        'ticketType', tt.name,
        'mpesaCode', p.mpesa_receipt_number,
        'submittedAt', p.code_submitted_at
      ) ORDER BY p.code_submitted_at
    ),
    '[]'::jsonb
  )
  FROM public.payments p
  JOIN public.orders o ON o.id = p.order_id
  JOIN public.ticket_types tt ON tt.id = o.ticket_type_id
  WHERE o.event_id = p_event_id
    AND p.status = 'PENDING'
    AND p.mpesa_receipt_number IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.admin_approve_manual_payment(
  p_payment_id uuid,
  p_admin_user_id uuid
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
  SELECT * INTO v_payment FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_NOT_FOUND'; END IF;

  IF v_payment.status = 'PAID' THEN
    RETURN jsonb_build_object('status', 'PAID');
  END IF;

  IF v_payment.status <> 'PENDING' THEN RAISE EXCEPTION 'PAYMENT_NOT_PENDING'; END IF;
  IF v_payment.mpesa_receipt_number IS NULL THEN RAISE EXCEPTION 'NO_CODE_SUBMITTED'; END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = v_payment.order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF v_order.status <> 'PENDING' THEN RAISE EXCEPTION 'ORDER_NOT_PENDING'; END IF;

  SELECT * INTO v_ticket_type FROM public.ticket_types WHERE id = v_order.ticket_type_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'TICKET_TYPE_NOT_FOUND'; END IF;

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
      result_code = 0,
      result_description = 'Approved by admin after checking M-Pesa records',
      approved_by = p_admin_user_id,
      approved_at = now()
  WHERE id = v_payment.id;

  UPDATE public.orders
  SET status = 'PAID',
      commission_amount = round(v_order.amount * v_order.commission_rate / 100, 2)
  WHERE id = v_order.id;

  RETURN jsonb_build_object('status', 'PAID');
END;
$$;

REVOKE ALL ON FUNCTION public.submit_manual_payment_code(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_pending_payments(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_approve_manual_payment(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.submit_manual_payment_code(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_pending_payments(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_approve_manual_payment(uuid, uuid) TO service_role;