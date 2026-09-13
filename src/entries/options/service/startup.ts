import { fixAllStoredUserInfo } from "@/background/utils/fixer.ts";

export function startStoredUserInfoRepair() {
  void fixAllStoredUserInfo().catch((error) => {
    console.error("[startup] Failed to repair stored user information", error);
  });
}
