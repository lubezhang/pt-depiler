import { useTableCustomFilter } from "@/options/directives/useAdvanceFilter.ts";

import type { IUserInfoItem } from "./lastUserData.ts";

// 页面在菜单切换时会被卸载；模块级实例用于保留当前会话中的筛选状态。
export const tableCustomFilter = useTableCustomFilter<IUserInfoItem>({
  parseOptions: {
    keywords: ["site", "status", "siteUserConfig.groups"],
    ranges: ["updateAt", "messageCount"],
  },
  titleFields: ["site", "siteName", "name"],
  format: {
    status: "number",
  },
});
