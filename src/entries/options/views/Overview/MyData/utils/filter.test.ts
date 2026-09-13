import { afterEach, describe, expect, it } from "vitest";

import { tableCustomFilter } from "./filter.ts";

function useMyDataFilter() {
  return tableCustomFilter;
}

afterEach(() => {
  tableCustomFilter.reBuildAdvanceFilter();
  tableCustomFilter.updateTableFilterValueFn();
});

describe("我的数据筛选状态", () => {
  it("在页面消费者重建后保留站点状态筛选", () => {
    const firstPage = useMyDataFilter();
    firstPage.advanceFilterDictRef.value.status.required = ["2", "5"];
    firstPage.updateTableFilterValueFn();

    const restoredPage = useMyDataFilter();

    expect(restoredPage.advanceFilterDictRef.value.status.required).toEqual(["2", "5"]);
    expect(restoredPage.tableWaitFilterRef.value).toContain("status:");
  });
});
