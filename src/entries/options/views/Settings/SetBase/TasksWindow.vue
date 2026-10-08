<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { invokeIpc } from "~/extends/tauri/ipc.ts";
import { sendMessage } from "@/messages.ts";

interface TaskStatus {
  id: string;
  kind: string;
  resourceId: string;
  state: string;
  attempt: number;
  runAt: number;
  lastError: string | null;
  cancelRequested: boolean;
  backupFilename: string | null;
}

const tasks = ref<TaskStatus[]>([]);
const loading = ref(false);
const error = ref("");
const busyId = ref("");

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    tasks.value = (await invokeIpc("list_task_status", {})) as TaskStatus[];
  } catch {
    error.value = "读取任务状态失败";
  } finally {
    loading.value = false;
  }
}

async function cancel(task: TaskStatus) {
  busyId.value = task.id;
  try {
    await invokeIpc("request_task_cancel", { taskId: task.id });
    await refresh();
  } catch {
    error.value = "取消请求失败";
  } finally {
    busyId.value = "";
  }
}

async function resolve(task: TaskStatus, action: "retry" | "succeeded" | "cancelled") {
  busyId.value = task.id;
  try {
    await invokeIpc("resolve_task", { taskId: task.id, action });
    await refresh();
  } catch {
    error.value = "任务状态更新失败，请刷新后重试";
  } finally {
    busyId.value = "";
  }
}

async function verifyBackup(task: TaskStatus) {
  const serverId = task.resourceId.startsWith("backup:") ? task.resourceId.slice(7) : "";
  if (!serverId || !task.backupFilename) {
    error.value = "此任务缺少远端核对信息，请人工检查备份记录";
    return;
  }
  busyId.value = task.id;
  error.value = "";
  try {
    const confirmed = await sendMessage("confirmBackupCompletion", {
      backupServerId: serverId,
      backupFilename: task.backupFilename,
    });
    if (!confirmed) {
      error.value = "远端未找到对应备份；任务保持待核对状态";
      return;
    }
    await invokeIpc("resolve_task", { taskId: task.id, action: "succeeded" });
    await refresh();
  } catch {
    error.value = "远端备份核对失败；任务保持待核对状态";
  } finally {
    busyId.value = "";
  }
}

onMounted(() => {
  void refresh();
  window.addEventListener("focus", refresh);
});
onUnmounted(() => window.removeEventListener("focus", refresh));
</script>

<template>
  <div class="d-flex align-center justify-space-between mb-4">
    <h3 class="text-h6">持久任务</h3>
    <v-btn icon="mdi-refresh" variant="text" :loading="loading" aria-label="刷新任务" @click="refresh" />
  </div>
  <v-alert v-if="error" type="error" density="compact" class="mb-3">{{ error }}</v-alert>
  <v-table density="compact">
    <thead>
      <tr>
        <th>任务</th>
        <th>资源</th>
        <th>状态</th>
        <th>下次执行</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="task in tasks" :key="task.id">
        <td>
          <strong>{{ task.kind }}</strong
          ><br /><small>{{ task.id }}</small>
        </td>
        <td>{{ task.resourceId }}</td>
        <td>
          {{ task.state }}<span v-if="task.cancelRequested"> · 已请求取消</span><br /><small>{{
            task.lastError
          }}</small>
        </td>
        <td>{{ new Date(task.runAt).toLocaleString() }}</td>
        <td class="text-no-wrap">
          <template v-if="task.state === 'uncertain' || task.state === 'failed'">
            <v-btn
              v-if="task.kind === 'autoBackup'"
              size="small"
              variant="text"
              :disabled="busyId === task.id"
              prepend-icon="mdi-cloud-search"
              @click="verifyBackup(task)"
              >核对远端</v-btn
            >
            <v-btn
              v-if="task.kind === 'autoBackup'"
              size="small"
              variant="text"
              prepend-icon="mdi-open-in-new"
              :to="{ name: 'SetBackup' }"
              >核对备份</v-btn
            >
            <v-btn size="small" variant="text" :disabled="busyId === task.id" @click="resolve(task, 'retry')">{{
              task.kind === "autoBackup" ? "确认后重试" : "重试"
            }}</v-btn>
            <v-btn size="small" variant="text" :disabled="busyId === task.id" @click="resolve(task, 'succeeded')"
              >确认完成</v-btn
            >
            <v-btn size="small" variant="text" :disabled="busyId === task.id" @click="resolve(task, 'cancelled')"
              >确认取消</v-btn
            >
          </template>
          <v-btn
            v-else-if="task.state === 'running' || task.state === 'scheduled' || task.state === 'retry_wait'"
            size="small"
            variant="text"
            :disabled="busyId === task.id || task.cancelRequested"
            @click="cancel(task)"
            >取消</v-btn
          >
        </td>
      </tr>
      <tr v-if="!tasks.length">
        <td colspan="5" class="text-center">暂无任务</td>
      </tr>
    </tbody>
  </v-table>
</template>
