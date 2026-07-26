export type CallbackPolicy = {
  allowedOrigins: string[];
  allowInsecureHttp: boolean;
};

export function validateCallbackUrl(
  value: string,
  policy: CallbackPolicy,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Callback URL is invalid");
  }
  if (url.username || url.password)
    throw new Error("Callback URL must not contain credentials");
  if (url.search) throw new Error("Callback URL must not contain a query");
  if (url.hash) throw new Error("Callback URL must not contain a fragment");
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && policy.allowInsecureHttp)
  ) {
    throw new Error(
      "Callback URL requires HTTPS unless insecure HTTP is explicitly allowed",
    );
  }
  if (!policy.allowedOrigins.includes(url.origin))
    throw new Error("Callback URL origin is not allowed");
  return url;
}
