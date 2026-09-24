import { computed, ref, watch, type Ref } from 'vue';
import { filePreviewSchema, type FilePreview, type Thread } from '@flux-agent/contracts';
import { request } from '../api/client';
import { parseToolObject, toolPresentation, type ToolInspection } from '../components/tool-presentation';

export interface InspectorTab {
  id: string;
  title: string;
  inspection?: ToolInspection;
  file?: FilePreview;
  source?: 'read' | 'write' | 'current';
  line?: number;
  loading: boolean;
  error: string;
  requestVersion: number;
}

/** 文件预览的生命周期属于当前会话；只管理展示数据，不改动运行和模型消息。 */
export function useToolInspector(thread: Ref<Thread | undefined>) {
  const tabs = ref<InspectorTab[]>([]);
  const activeId = ref('');
  const active = computed(() => tabs.value.find((tab) => tab.id === activeId.value));

  function open(inspection: ToolInspection) {
    const { step } = inspection;
    if (!['read_file', 'write_file'].includes(step.name)) return;
    const input = parseToolObject(step.input);
    const isFile =
      (step.status === 'succeeded' && ['read_file', 'write_file'].includes(step.name)) || !!inspection.approval;
    const file =
      isFile && typeof input.path === 'string'
        ? { path: input.path, content: step.name === 'read_file' ? step.output : String(input.content ?? '') }
        : undefined;
    if (!file) return;
    const tab: InspectorTab = {
      id: inspection.id,
      title:
        typeof input.path === 'string'
          ? input.path.split('/').filter(Boolean).at(-1) || input.path
          : toolPresentation(step.name).label,
      inspection,
      file,
      source: file ? (step.name === 'read_file' ? 'read' : 'write') : undefined,
      loading: false,
      error: '',
      requestVersion: 0,
    };
    const index = tabs.value.findIndex((entry) => entry.id === tab.id);
    if (index < 0) tabs.value.push(tab);
    else tabs.value[index] = tab;
    activeId.value = tab.id;
  }

  async function loadFile(tab: InspectorTab, path: string) {
    const threadId = thread.value?.id;
    if (!threadId) return;
    const version = ++tab.requestVersion;
    tab.loading = true;
    tab.error = '';
    try {
      const file = await request(`/threads/${threadId}/file?path=${encodeURIComponent(path)}`, filePreviewSchema);
      if (version !== tab.requestVersion) return;
      tab.file = file;
      tab.source = 'current';
    } catch (error) {
      if (version === tab.requestVersion) tab.error = error instanceof Error ? error.message : '文件读取失败。';
    } finally {
      if (version === tab.requestVersion) tab.loading = false;
    }
  }

  function openFile(path: string, line?: number) {
    const id = `file:${path}`;
    let tab = tabs.value.find((entry) => entry.id === id);
    if (!tab) {
      tabs.value.push({
        id,
        title: path.split('/').at(-1) || path,
        file: { path, content: '' },
        loading: false,
        error: '',
        requestVersion: 0,
      });
      tab = tabs.value.at(-1)!;
    }
    tab.line = line;
    activeId.value = id;
    void loadFile(tab, path);
  }

  function refresh() {
    if (active.value?.file) void loadFile(active.value, active.value.file.path);
  }

  function close(id: string) {
    const index = tabs.value.findIndex((tab) => tab.id === id);
    tabs.value = tabs.value.filter((tab) => tab.id !== id);
    if (activeId.value === id) activeId.value = tabs.value[Math.min(index, tabs.value.length - 1)]?.id || '';
  }

  function clear() {
    tabs.value = [];
    activeId.value = '';
  }

  watch(() => thread.value?.id, clear);
  return { tabs, activeId, active, open, openFile, refresh, close, clear };
}
