
# Club POS System

This is a code bundle for Club POS System. The original project is available at https://www.figma.com/design/m4oh4lWywtq6ddUTNMXcK6/Club-POS-System.

## Running the code

Run `npm i` to install the dependencies.

Run `npm run dev` to start the festival website at `http://localhost:5174`. Port `5174` is reserved for this project so it does not open on the POS project's `localhost:5173`. Startup fails if `5174` is already in use rather than switching to another project's port.

## Production readiness checklist

Before deploying to production, make sure these environment variables are configured in the deployment environment:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ALLOWED_ORIGINS` (comma-separated list of domains, for example `https://example.com,https://www.example.com`)
- `DARAJA_ENVIRONMENT` (`sandbox` or `production`)
- `DARAJA_BASE_URL` (optional override, for example `https://api.safaricom.co.ke` for production or `https://sandbox.safaricom.co.ke` for sandbox)
- `DARAJA_CONSUMER_KEY`
- `DARAJA_CONSUMER_SECRET`
- `DARAJA_SHORTCODE`
- `DARAJA_PASSKEY`
- `DARAJA_CALLBACK_URL`

Important launch notes:

- Keep the Supabase service-role key server-side only.
- Restrict CORS to known production domains.
- Set `DARAJA_ENVIRONMENT=production` and use live payment credentials for a real M-Pesa setup.
- Use a real HTTPS callback URL that points to your deployed server.
- Verify the full payment flow before launch.

## Deploying the Supabase payment flow

Apply the database migration before deploying the Edge Function because order creation and payment finalization use database RPCs defined by that migration:

```sh
supabase db push --linked
supabase functions deploy server --project-ref <project-ref> --use-api --no-verify-jwt
```

For sandbox testing, set `DARAJA_ENVIRONMENT=sandbox` in the Edge Function secrets and use the Safaricom sandbox credentials and callback URL. The callback URL must target `/functions/v1/server/mpesa-callback`. Do not use live Daraja credentials until production configuration and payment verification have been tested.

`create-order` applies a shared per-phone limit of five attempts per 15-minute window and returns `429` with `Retry-After` when exceeded. Configure CORS using exact origins in `ALLOWED_ORIGINS`; local origins are not implicitly allowed.

## Ticketing MVP: admin, referrals, and QR check-in

Apply `supabase/migrations/20261021020000_ticketing_mvp.sql` after the payment-safety migration. It adds event-scoped promoter referrals, private ticket receipt links, one-time ticket check-in, event edition creation, and the dashboard summary RPC. Existing paid orders remain intact; their receipt links are not retroactively created.

Create one Supabase Auth user for the festival administrator and set the Edge Function secret `ADMIN_EMAIL` to that account's exact email address (`bushnbeatfest@gmail.com`). The admin signs in at `/admin`; the server verifies the Supabase access token and email on every protected action. Promoters do not sign in and ticket buyers do not create accounts. The admin creates promoter referral links, while buyers use a private `/ticket?token=...` page. Only an order confirmed as paid receives QR tickets.

The admin dashboard can create future editions with their own Advance and Gate ticket types. The checkout edition selector lists upcoming editions and keeps orders, promoters, commissions, tickets, and check-ins scoped to the selected event. Use HTTPS for camera-based QR scanning; manual ticket-code entry remains available if the camera cannot be used.

This migration and the matching Edge Function/frontend changes must be deployed together. Review and apply the migration before deploying the function. Configure `ADMIN_EMAIL` before the dashboard is used. Do not run a live payment test without explicitly authorizing it.

## Deploying the frontend to Vercel

The repository is configured for a Vercel static Vite deployment. From the project directory:

```sh
npm install --global vercel
vercel login
vercel
vercel --prod
```

When prompted, link the project to your Vercel account. The build command is `npm run build`, the output directory is `dist`, and dependencies are installed with `npm ci`. Review the preview deployment before running the production deploy.

After production deploy, add `www.bushnbeatfest.com` under the Vercel project's Domains settings and follow its DNS instructions. The Supabase Edge Function CORS allowlist is currently set to `https://www.bushnbeatfest.com`. If the apex domain `https://bushnbeatfest.com` should also serve the site, add it to `ALLOWED_ORIGINS` in Supabase before using that address.

The frontend uses only the public Supabase project configuration. Do not add the Supabase service-role key or Daraja credentials to Vercel frontend environment variables.
