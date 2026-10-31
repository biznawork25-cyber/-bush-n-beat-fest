export async function functionErrorMessage(error: unknown): Promise<string> {
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    try {
      const body = await context.clone().json();
      if (body && typeof body.error === "string") return body.error;
    } catch {
      // Body was not JSON; fall through to the generic message.
    }
  }
  return error instanceof Error ? error.message : "Something went wrong";
}