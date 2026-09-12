export type TCookieSameSite = "unspecified" | "no_restriction" | "lax" | "strict";

export interface ICookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  expirationDate?: number;
  sameSite: TCookieSameSite;
  storeId?: string;
}

export interface ICookieQuery {
  domain?: string;
  url?: string;
}

export type ICookieInput = Pick<ICookie, "name" | "value"> &
  Partial<Omit<ICookie, "name" | "value" | "session" | "sameSite">> & {
    url?: string;
    sameSite?: TCookieSameSite;
  };
