import { fixAllStoredUserInfo } from "@/background/utils/fixer.ts";

export async function startStoredUserInfoRepair(): Promise<void> {
  await fixAllStoredUserInfo();
}
