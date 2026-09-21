(() => {
  'use strict';
  const status = document.getElementById('status');
  const diagnostics = document.getElementById('diagnostics');
  const retry = document.getElementById('retry');
  const replay = document.getElementById('replay');
  const pending = new Map(), runs = new Map();
  let nextId = 1, initialized = false, current, latest;
  const startup = { ui_version: 'v1', loaded_at: new Date().toISOString(), protocol: 'pending' };
  const clean = error => String(error?.message || error).replace(/https?:\/\/\S+/g, '[URL]').replace(/[A-Za-z0-9+/=_-]{100,}/g, '[redacted]').slice(0, 400);
  function capabilities() {
    return { uploadFile: typeof window.openai?.uploadFile === 'function', setWidgetState: typeof window.openai?.setWidgetState === 'function', sendFollowUpMessage: typeof window.openai?.sendFollowUpMessage === 'function', mcpApps: initialized };
  }
  function show(message) {
    if (message) status.textContent = message;
    diagnostics.textContent = JSON.stringify({ ...startup, capabilities: capabilities(), ...(current || {}) }, null, 2);
    retry.disabled = !current?.can_click || current?.busy;
    replay.disabled = !latest || current?.busy;
  }
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ': response timeout; outcome unknown')); }, 12000);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    });
  }
  function save(run) {
    try { sessionStorage.setItem('x14-vision:' + run.run_id, JSON.stringify(run)); } catch { run.storage = 'unavailable'; }
  }
  function state(run, imageIds) {
    window.openai.setWidgetState({ modelContent: { experiment: 'vision_widget_probe', run_id: run.run_id, sample_id: run.sample_id, status: run.stage, publish_images: run.publish_images }, privateContent: { visionProbe: { ...run, busy: false } }, imageIds });
  }
  function step(run, stage) {
    run.stage = stage;
    (run.events ||= []).push({ stage, at: new Date().toISOString() });
    save(run); show(stage);
  }
  async function prepare(data, payload) {
    if (data.mime_type !== 'image/png' || !Number.isInteger(data.bytes) || data.bytes > 1048576 || data.bytes < 8 || !/^[a-f0-9]{64}$/.test(data.sha256)) throw new Error('INVALID_IMAGE_METADATA');
    if (typeof payload?.base64 !== 'string' || payload.base64.length > 1400000) throw new Error('PRIVATE_IMAGE_PAYLOAD_MISSING');
    const raw = atob(payload.base64), bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
    if (bytes.length !== data.bytes || [...bytes.slice(0, 8)].join(',') !== '137,80,78,71,13,10,26,10') throw new Error('IMAGE_BYTES_MISMATCH');
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
    if (sha !== data.sha256) throw new Error('IMAGE_HASH_MISMATCH');
    return new File([bytes], 'vision-sample.png', { type: 'image/png' });
  }
  function restore(data) {
    const widget = window.openai?.widgetState?.privateContent?.visionProbe;
    if (widget?.run_id === data.run_id && widget.sha256 === data.sha256) return widget;
    try {
      const cached = JSON.parse(sessionStorage.getItem('x14-vision:' + data.run_id));
      if (cached?.run_id === data.run_id && cached.sha256 === data.sha256) return cached;
    } catch {}
  }
  async function perform(run, file, byClick) {
    if (run.busy || run.file_id || (run.upload_attempted && !byClick)) return;
    if (byClick && run.click_attempted) return;
    run.busy = true; run.can_click = false;
    if (byClick) run.click_attempted = true;
    run.trigger = byClick ? 'click' : 'auto';
    try {
      if (!capabilities().uploadFile || !capabilities().setWidgetState) throw new Error('HOST_API_UNAVAILABLE');
      run.upload_attempted = true;
      step(run, 'upload_pending');
      state(run, []);
      let uploaded;
      try {
        // No await before uploadFile in the click path: preserve the user gesture.
        const upload = window.openai.uploadFile(file);
        let timer;
        try { uploaded = await Promise.race([upload, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('UPLOAD_TIMEOUT_UNKNOWN')), 30000); })]); }
        finally { clearTimeout(timer); }
      } catch (error) {
        run.can_click = !byClick && clean(error) !== 'UPLOAD_TIMEOUT_UNKNOWN';
        throw error;
      }
      if (typeof uploaded?.fileId !== 'string' || !uploaded.fileId.trim()) throw new Error('UPLOAD_RESULT_NO_FILE_ID');
      run.file_id = uploaded.fileId;
      step(run, 'upload_registered');
      step(run, 'image_reference_pending');
      state(run, run.publish_images ? [run.file_id] : []);
      step(run, 'image_reference_written');
      run.followup_attempted = true; save(run);
      const prompt = '本地图片实验 ' + run.run_id + '，样本 ' + run.sample_id + '。图片登记步骤已完成，publish_images=' + run.publish_images + '。请只根据你实际可感知的当前图片，报告顶部完整字符码及左上、右上、左下、右下各自颜色和形状；无图或不清楚就说明。不调用任何工具，不重新启动实验，不根据样本名或历史答案推测。';
      step(run, 'followup_pending');
      // Persist before sending; a remount must not send a second message.
      state(run, run.publish_images ? [run.file_id] : []);
      if (initialized) {
        run.followup_transport = 'ui/message';
        const result = await request('ui/message', { role: 'user', content: [{ type: 'text', text: prompt }] });
        if (result?.isError) throw new Error('FOLLOWUP_REJECTED');
      } else if (capabilities().sendFollowUpMessage) {
        run.followup_transport = 'sendFollowUpMessage';
        await window.openai.sendFollowUpMessage({ prompt });
      } else throw new Error('FOLLOWUP_API_UNAVAILABLE');
      step(run, 'followup_requested_not_vision_proven');
      state(run, run.publish_images ? [run.file_id] : []);
    } catch (error) {
      run.error = clean(error); run.failed_at = run.stage;
      step(run, 'stopped');
    } finally { run.busy = false; save(run); show(); }
  }
  async function receive(result) {
    const data = result?.structuredContent;
    if (!data?.run_id || data.ui_version !== 'v1') return;
    latest = result;
    const previous = runs.get(data.run_id);
    const retryReadiness = previous && !previous.busy && !previous.upload_attempted &&
      ((previous.error === 'PRIVATE_IMAGE_PAYLOAD_MISSING' && result._meta?.['x14/vision']) ||
       (previous.error === 'HOST_API_UNAVAILABLE' && capabilities().uploadFile && capabilities().setWidgetState));
    if (previous && !retryReadiness) {
      current = runs.get(data.run_id); current.duplicate_notifications = (current.duplicate_notifications || 0) + 1;
      show(); return;
    }
    // A new result must not race an unfinished upload in this widget.
    if (current?.busy) { show('前一个实验仍在执行；请等待后重新载入新结果。'); return; }
    const old = retryReadiness ? null : restore(data);
    current = old ? { ...old, busy: false, can_click: false, restored: true } : { ...data, stage: 'received', events: [], busy: false };
    const run = current; runs.set(run.run_id, run);
    if (old?.upload_attempted) { show('已恢复实验记录；不重复上传或续答。'); return; }
    try {
      if (data.status !== 'ready') {
        step(run, data.status);
        if (capabilities().setWidgetState) state(run, []);
        else run.clear_reference = 'HOST_API_UNAVAILABLE';
        show(); return;
      }
      run.busy = true;
      const file = await prepare(data, result._meta?.['x14/vision']);
      run.busy = false;
      step(run, 'image_bytes_verified');
      if (!capabilities().uploadFile || !capabilities().setWidgetState) throw new Error('HOST_API_UNAVAILABLE');
      retry.onclick = () => { void perform(run, file, true); };
      if (data.mode === 'click') { run.can_click = true; show('图片已取得；等待点击登记。'); }
      else await perform(run, file, false);
    } catch (error) { run.busy = false; run.error = clean(error); run.failed_at = run.stage; step(run, 'stopped'); }
  }
  function legacy() {
    const api = window.openai;
    const meta = api?.toolResponseMetadata;
    const envelope = meta?.mcp_tool_result || meta?.call_tool_result;
    if (envelope?.structuredContent) void receive(envelope);
    else if (api?.toolOutput?.run_id) void receive({ structuredContent: api.toolOutput, _meta: envelope?._meta || meta?._meta || meta });
    show();
  }
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') return;
    const message = event.data;
    if (pending.has(message.id)) {
      const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(message.error) : entry.resolve(message.result); return;
    }
    if (message.method === 'ui/notifications/tool-result') void receive(message.params);
  });
  window.addEventListener('openai:set_globals', legacy);
  replay.onclick = () => { if (latest) void receive(latest); };
  request('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'X14 vision experiment', version: '1.0.0' }, appCapabilities: {} }).then(() => {
    initialized = true; startup.protocol = 'initialized';
    window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
    legacy();
  }).catch(error => { startup.protocol = clean(error); legacy(); });
  // Legacy-only hosts may already supply globals without an MCP Apps handshake.
  legacy();
})();
