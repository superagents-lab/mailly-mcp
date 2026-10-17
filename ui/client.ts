import DOMPurify from 'dompurify';
import { originalEmail } from './original-email.js';
import { iconify } from './icons.js';

type Row = Record<string, any>;
type Host = { askAssistant: (text: string) => Promise<void>; call: (name: string, args?: Row) => Promise<Row>; openThread: (id: string) => Promise<void>; inbox: (folder?: string) => Promise<void>; suspend: () => void; permissions: () => Row; openLink: (url: string) => Promise<void>; notice: (text: string) => void };
type Column = [string, (row: Row) => unknown];
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
const labels: Record<string, string> = { pending:'Needs review', sent:'Submitted', delivered:'Delivered', failed:'Failed', queued:'Queued', sending:'Sending', active:'Active', suppressed:'Suppressed', deleted:'Deleted', draft:'Draft', published:'Published', archived:'Archived', paused:'Paused', completed:'Completed', canceled:'Canceled', scheduled:'Scheduled', off:'Off', summarize:'Analyze only', done:'Done', running:'Running', skipped:'Skipped', approved:'Approved', discarded:'Discarded' };
Object.assign(labels, { transactional:'Transactional', lifecycle:'Lifecycle', marketing:'Marketing', verified:'Verified', unverified:'Unverified', hard_bounced:'Hard bounce', soft_bounced:'Soft bounce', complained:'Complaint', deferred:'Deferred', opened:'Opened', clicked:'Clicked' });
const status = (value: unknown) => labels[String(value)] || String(value ?? '—');
const when = (value: unknown) => { if (!value) return '—'; const d = new Date(typeof value === 'number' ? value * 1000 : String(value)); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-US'); };
const groups = [
  ['Mail', [['inbox','Inbox'],['outbox','Sent']]],
  ['Automation', [['campaigns','Campaign'],['workflows','Workflow']]],
] as const;
const titles: Record<string, string> = { compose:'Compose', contacts:'Choose contacts', templates:'Choose template' };
for (const [, items] of groups) for (const [key, label] of items) titles[key] = label;
const descriptions: Record<string, string> = {
  outbox:'View sent emails and delivery results.', compose:'Compose an email and review it before sending.',
  contacts:'Choose a recipient and return to your email.', templates:'Preview a template and use it in your email.',
  campaigns:'Configure campaigns with Codex. Review content, audience, and delivery here.', workflows:'Configure triggers and steps with Codex. Review, publish, and monitor runs here.',
};
export function createClient(host: Host) {
  const nav = document.getElementById('app-nav')!;
  const area = document.getElementById('client-page')!;
  const inbox = document.getElementById('inbox-area')!;
  let active = 'inbox';
  let routeVersion = 0;
  const views = new Map<string, HTMLElement>();
  let composeState: Row = { to:'', fromEmail:'', fromName:'', subject:'', html:'', emailType:'transactional' };
  let composeAttempted = false;
  const read = (operation: string, id?: string, query?: Row) => host.call('mailly_client_read', { operation, ...(id ? { id } : {}), ...(query ? { query } : {}) });
  const manage = (operation: string, id?: string, body?: Row) => host.call('mailly_client_manage', { operation, id, body, confirmed: true });
  const canManage = () => host.permissions().manage === true;
  function button(label: string, fn: () => Promise<unknown> | unknown, cls = '') {
    const b = node('button', label, `btn cursor-interaction ${cls}`); b.type = 'button';
    b.onclick = async () => { if (b.disabled) return; b.disabled = true; try { await fn(); } catch (e) { host.notice((e as Error).message); } finally { if (b.dataset.locked !== 'true') b.disabled = false; } }; return iconify(b, label);
  }
  function box(title: string, ...children: HTMLElement[]) { const s = node('section', '', 'client-section'); s.append(node('h2', title), ...children); return s; }
  function pairs(values: Row) {
    const dl = node('dl', '', 'client-facts');
    for (const [k,v] of Object.entries(values)) { if (v === undefined || v === null) continue; dl.append(node('dt', k), node('dd', typeof v === 'object' ? JSON.stringify(v) : String(v))); } return dl;
  }
  function table(rows: Row[], columns: Column[], select?: (r: Row) => Promise<unknown>) {
    if (!rows.length) return node('p', 'No records yet.', 'empty');
    const wrap = node('div', '', 'client-table-wrap'), t = node('table', '', 'client-table'), head = node('thead'), hr = node('tr');
    for (const [label] of columns) hr.append(node('th', label)); head.append(hr); t.append(head);
    const body = node('tbody');
    for (const row of rows) { const tr = node('tr'); columns.forEach(([, get], i) => { const cell = node('td'); const value = String(get(row) ?? '—'); cell.append(i === 0 && select ? button(value, () => select(row), 'btn-ghost row-link') : node('span', value)); tr.append(cell); }); body.append(tr); }
    t.append(body); wrap.append(t); return wrap;
  }
  function email(html: string, text = '') { return html ? originalEmail(html, host.openLink) : node('div', text, 'plain-body'); }
  async function confirm(title: string, content: HTMLElement, action: () => Promise<unknown>, label = 'Confirm') {
    const dialog = node('dialog', '', 'client-dialog'), actions = node('div', '', 'actions');
    const close = () => { dialog.close(); dialog.remove(); };
    const accept = button(label, async () => { await action(); close(); }, 'btn-primary brand-action');
    actions.append(button('Cancel', close), accept); dialog.append(node('h2', title), content, actions); document.body.append(dialog);
    dialog.addEventListener('cancel', close); dialog.showModal();
  }
  type Field = { key: string; label: string; value?: unknown; required?: boolean; type?: string; options?: [string,string][]; hint?: string };
  function form(fields: Field[], save: (values: Row) => Promise<void>, label = 'Save') {
    const f = node('form', '', 'client-form'); const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
    for (const field of fields) {
      const l = node('label', '', 'client-field'); l.append(node('span', field.label));
      const input = field.options ? node('select') : field.type === 'textarea' ? node('textarea') : node('input');
      input.className = 'form-control'; input.name = field.key; input.setAttribute('aria-label', field.label); input.required = !!field.required;
      if (input instanceof HTMLSelectElement) for (const [value, text] of field.options!) { const o = node('option', text); o.value = value; input.append(o); }
      if (input instanceof HTMLInputElement) input.type = field.type || 'text';
      if (input instanceof HTMLTextAreaElement) input.rows = 5;
      input.value = String(field.value ?? ''); inputs.set(field.key, input); l.append(input);
      if (field.hint) l.append(node('small', field.hint, 'muted')); f.append(l);
    }
    const submit = node('button', label, 'btn btn-primary brand-action cursor-interaction'); submit.type = 'button';
    f.append(submit); f.onsubmit = event => event.preventDefault();
    // MCP iframes may forbid native form submissions, even to the same origin.
    // Keep validation local and send values only through the host tool bridge.
    submit.onclick = async () => { if (submit.disabled || !f.reportValidity()) return; submit.disabled = true; try { await save(Object.fromEntries([...inputs].map(([k,v]) => [k,v.value]))); } catch(e) { host.notice((e as Error).message); } finally { submit.disabled = false; } };
    f.onkeydown = event => { if(event.key==='Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); submit.click(); } }; return f;
  }
  function heading(page: HTMLElement, title: string, description?: string) { const h = node('div', '', 'client-heading'); h.append(node('h1', title)); if(description) h.append(node('p', description, 'muted')); page.append(h); return h; }
  async function subpage(title: string, load: (page: HTMLElement) => Promise<void>) {
    const version = ++routeVersion; const page = node('div', '', 'client-content'); area.replaceChildren(page); heading(page, title);
    page.prepend(button('Back to list', () => navigate(active), 'btn-ghost'));
    try { await load(page); } catch(e) { if(version === routeVersion) page.append(node('p', (e as Error).message, 'hint'), button('Retry', () => subpage(title, load))); }
  }
  async function list(page: HTMLElement, operation: string, array: string, columns: Column[], select?: (r: Row) => Promise<unknown>, query: Row = {}, recordId?: string) {
    const holder = node('div'), footer = node('div', '', 'client-pagination'); page.append(holder, footer);
    let offset = 0, pageCursor: string | undefined; let rows: Row[] = [];
    const more = button('Load more', () => load(true));
    async function load(append = false) {
      const result = await read(operation, recordId, { limit:50, ...query, offset, ...(pageCursor ? { cursor:pageCursor } : {}) });
      const next = result[array] ?? []; rows = append ? [...rows, ...next] : next;
      holder.replaceChildren(table(rows, columns, select)); offset += next.length; pageCursor = result.cursor || undefined;
      more.hidden = result.hasMore === false || (!result.hasMore && !pageCursor && next.length < 50);
      footer.replaceChildren(node('span', `${rows.length} records${typeof result.total === 'number' ? ` / ${result.total} total` : ''}`, 'muted'), more);
    }
    await load();
  }
  async function navigate(route: string, force = false) {
    host.suspend(); active = route; ++routeVersion; host.notice('');
    nav.querySelectorAll<HTMLButtonElement>('[data-route]').forEach(b => { if((b.dataset.route === route || (route==='quarantine'&&b.dataset.route==='inbox'))) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current'); });
    document.getElementById('client-shell')!.classList.remove('nav-open');
    const isInbox = route === 'inbox' || route === 'quarantine'; inbox.hidden = !isInbox; area.hidden = isInbox;
    const folderSelect=document.getElementById('mail-folder') as HTMLSelectElement;folderSelect.value=route==='quarantine'?'quarantine':'inbox';
    if(isInbox) { await host.inbox(route === 'quarantine' ? 'quarantine' : 'inbox'); return; }
    if(force) views.delete(route);
    if(views.has(route)) { area.replaceChildren(views.get(route)!); return; }
    const page = node('div', '', 'client-content'); views.set(route,page); area.replaceChildren(page); heading(page, titles[route] || route, descriptions[route]);
    page.setAttribute('aria-busy','true'); const loading=node('p','Loading…','muted'); page.append(loading);
    try { await render(route,page); } catch(e) { views.delete(route); page.append(node('p', (e as Error).message, 'hint'), button('Retry', () => navigate(route,true))); }
    finally { loading.remove(); page.setAttribute('aria-busy','false'); }
  }
  async function render(route: string, page: HTMLElement) {
    if (route === 'outbox') {
      const search = form([{key:'q',label:'Search sender, recipient, or subject'}],async ({q})=>{ holder.replaceChildren(); await sentList(holder,q); },'Search');
      const holder = node('div'); page.append(search,holder); await sentList(holder); return;
    }
    if (route === 'compose') { await compose(page); return; }
    if (route === 'contacts') {
      page.append(button('Back to compose',()=>navigate('compose'),'btn-ghost'));
      await list(page,'contacts','contacts',[['Contact',r=>r.name||r.email],['Email',r=>r.email],['Status',r=>status(r.status)]],async r=>{
        composeState.to=[...new Set([...composeState.to.split(/[,;\s]+/).filter(Boolean),r.email])].join(', ');await navigate('compose',true);
      }); return;
    }
    if (route === 'templates') {
      page.append(button('Back to compose',()=>navigate('compose'),'btn-ghost'));
      await list(page,'templates','templates',[['Name',r=>r.name],['Status',r=>status(r.status)]],r=>subpage(r.name,async p=>{
        const data=await read('template',r.templateKey), def=data.template.draftDefinition, content=def.locales?.[def.defaultLocale]||{};
        p.append(pairs({'Subject':content.subject,'Content':'Current template draft'}),email(content.html,content.text),button('Use this template',()=>confirm('Use this template?',node('p','This replaces the subject and body and keeps the recipients. Review and complete all template variables.'),async()=>{
          composeState.subject=content.subject||'';composeState.html=content.html||DOMPurify.sanitize(node('div',content.text||'').outerHTML);composeState.fromEmail=def.from?.email||composeState.fromEmail;composeState.fromName=def.from?.name||'';composeState.emailType=def.emailType||'transactional';await navigate('compose',true);
        },'Use template'),'btn-primary brand-action'));
      })); return;
    }
    if (route === 'campaigns') {
      if(canManage()) page.append(button('Configure campaign with assistant',()=>configure('campaign'),'btn-primary brand-action'));
      page.append(node('p','Prepare content and audience. Saving does not send email.','muted'));
      await list(page,'campaigns','campaigns',[['Name',r=>r.name||r.campaign_key],['Status',r=>status(r.status)],['Recipients',r=>r.recipient_count],['Created',r=>when(r.created_at)]],r=>subpage(r.name||r.campaign_key,async p=>{
        const d=await read('campaign',r.campaign_key), c=d.campaign;
        p.append(pairs({'Status':status(c.status),'From':c.senderEmail,'Subject':c.subject}),box('Email body',email(c.html,c.text)),box('Sending report',pairs(d.report||{})));
        transitions(p,'campaign',r.campaign_key,c.status);
        if(canManage()) p.append(button('Edit with assistant',()=>configure('campaign',r.campaign_key)));
        p.append(pairs({'Frozen audience':d.audienceSnapshot?.resolvedRecipientCount,'Topic':c.topic,'Recipient reason':c.recipientReason}));
        if(c.status==='draft' && !composeAttempted) p.append(button('Compose and review',async()=>{
          const load=async()=>{composeState={to:'',fromEmail:c.senderEmail,fromName:c.fromName||'',subject:c.subject,html:c.html||DOMPurify.sanitize(node('div',c.text||'').outerHTML),emailType:c.emailType,campaignKey:r.campaign_key,topic:c.topic||'',recipientReason:c.recipientReason||''};views.delete('drafts');await navigate('compose',true);};
          if(composeState.subject||composeState.html||composeState.to) await confirm('Switch to campaign email?',node('p','This replaces the email being composed in this window.'),load,'Continue');else await load();
        }));
        if(d.audienceSnapshot) { p.append(node('h2','Frozen audience')); await list(p,'campaign_audience','members',[['Email',m=>m.email],['Name',m=>m.name]],undefined,{},r.campaign_key); }
        p.append(node('h2','Send history'));
        await list(p,'campaign_recipients','recipients',[['To',m=>m.recipient_email],['Sending status',m=>status(m.status)],['Delivery status',m=>status(m.delivery_status)],['Reason',m=>m.status_reason]],undefined,{},r.campaign_key);
      })); return;
    }
    if (route === 'workflows') {
      if(canManage()) page.append(button('Configure workflow with assistant',()=>configure('workflow'),'btn-primary brand-action'));
      await list(page,'workflows','workflows',[['Name',r=>r.name],['Status',r=>status(r.status)],['Active runs',r=>r.activeRunCount],['Version',r=>r.activeVersion]],r=>subpage(r.name,async p=>{
        const d=await read('workflow',r.workflowKey), w=d.workflow;
        p.append(pairs({'Status':status(w.status),'Active version':w.activeVersion ?? 'Not published'}));
        if(w.activeDefinition) p.append(workflowDefinition(w.activeDefinition,'Active version'));
        if(!w.activeDefinition || w.hasUnpublishedChanges) p.append(workflowDefinition(w.draftDefinition,'Unpublished draft'));
        if(canManage()) p.append(button('Edit with assistant',()=>configure('workflow',r.workflowKey)));
        if(canManage() && host.permissions().send && w.status!=='archived') p.append(button('Review and publish draft',()=>confirm('Publish workflow?',box('Runs automatically on matching events after publication',workflowDefinition(w.draftDefinition,'Configuration to publish'),node('p','Existing runs keep their original version. New runs use this version and may send email automatically.','muted')),async()=>{
          await manage('workflow_publish',r.workflowKey,{reviewed_definition:w.draftDefinition});await navigate('workflows',true);host.notice('Workflow published.');
        },'Confirm publication'),'btn-primary brand-action'));
        transitions(p,'workflow',r.workflowKey,w.status);
        const runs=await read('workflow_runs',r.workflowKey,{limit:100}); p.append(box('Run history',table(runs.runs||[],[['Contact',m=>m.email],['Status',m=>status(m.status)],['Current step',m=>m.currentStep],['Reason',m=>m.error||m.exitReason]])));
      })); return;
    }
  }
  function workflowDefinition(def:Row={},title='Workflow configuration') {
    const steps=node('ol','','workflow-steps');
    (def.steps||[]).forEach((step:Row)=>steps.append(node('li',step.type==='delay'?`Wait ${step.duration}`:step.type==='send'?`Send template ${step.template?.key} · Version ${step.template?.version}`:step.type==='exit'?`Exit: ${step.reason||''}`:`Check condition; when false: ${step.onFalse==='continue'?'Continue':'Exit'}`)));
    const details=node('details');details.append(node('summary','Full configuration','cursor-interaction'),node('pre',JSON.stringify(def,null,2),'workflow-json'));
    return box(title,pairs({'Trigger event':def.trigger?.event,'Exit events':def.exitOn?.join(', ')||'None','Reentry':def.reentry==='after_exit'?'Allow reentry after exit':'No reentry'}),steps,details);
  }
  async function configure(kind:'campaign'|'workflow',id?:string) {
    const label=kind==='workflow'?'Workflow':'Campaign';
    await host.askAssistant(`Help me ${id?'update the existing':'configure a new'} Mailly ${label}${id?` (key ${JSON.stringify(id)})`:''}. ${id?'Read the existing configuration first. ':''}Ask about my goals, audience or triggers, and email content before making assumptions. Save a draft using Mailly MCP configuration tools. Do not use the CLI, publish, resume, or send. Let me review the result in the plugin.`);
    host.notice(`Sent to Codex. Continue describing your ${label.toLowerCase()} requirements in chat.`);
  }
  async function sentList(page: HTMLElement,q='') {
    await list(page,'outbox','messages',[['Subject',r=>r.subject],['To',r=>r.recipient?.email],['Sending status',r=>status(r.transport?.status)],['Delivery status',r=>status(r.delivery?.status)],['Time',r=>when(r.createdAt)]],r=>subpage(r.subject,async p=>{
      const d=await read('outbox_detail',r.id), m=d.message;
      p.append(pairs({'From':m.from?.email,'To':m.recipient?.email,'Subject':m.subject,'Sending status':status(m.transport?.status),'Delivery status':status(m.delivery?.status),'Reason':m.transport?.reason,'Created':when(m.createdAt)}));
      if(m.source?.inbox?.threadId) p.append(button('View conversation',async()=>{ await navigate('inbox'); await host.openThread(m.source.inbox.threadId); }));
      p.append(box('Delivery events',table(d.events||[],[['Event',e=>status(e.type)],['Time',e=>when(e.timestamp)],['Reason',e=>e.reason]])));
    }),q?{q}:{});
  }
  function transitions(p: HTMLElement,kind: 'campaign'|'workflow',id: string,state: string) {
    if(!canManage()) return;
    const actions: [string,string][] = state==='paused' ? [['resume','Resume']] : ['sending','scheduled','published'].includes(state)?[['pause','Pause']]:[];
    if(kind==='campaign' && !['canceled','completed'].includes(state)) actions.push(['cancel','Cancel campaign']);
    if(kind==='workflow' && state!=='archived') actions.push(['archive','Archive']);
    for(const [op,label] of actions) { if(op==='resume' && !host.permissions().send) continue; p.append(button(label,()=>confirm(`${label}?`,node('p',op==='resume'?'Resuming may continue sending emails from this configuration.':`${label} this ${kind.toLowerCase()}?`),async()=>{ await manage(`${kind}_${op}`,id); await navigate(active,true); },label))); }
  }
  async function compose(p:HTMLElement) {
    if(!composeAttempted)p.append(button('Choose contacts',()=>navigate('contacts')),button('Use template',()=>navigate('templates')));
    const senderData=await read('domains',undefined,{include_unverified:1});
    const domains=(senderData.domains||[]).filter((d:Row)=>d.outboundEnabled || d.outboundStatus==='verified' || d.status==='verified');
    p.append(node('p',domains.length?`Available sender domains: ${domains.map((d:Row)=>d.domain).join(', ')}`:'Configure sender domains in Workspace settings.','muted'));
    const fields:Field[]=[{key:'fromEmail',label:'Sender email',type:'email',required:true},{key:'fromName',label:'Sender name'},{key:'to',label:'To',hint:'Separate recipients with commas or new lines. Leave empty to use a the frozen campaign audience.'},{key:'subject',label:'Subject',required:true},{key:'emailType',label:'Email type',options:[['transactional','Transactional'],['lifecycle','Lifecycle'],['marketing','Marketing']]},{key:'topic',label:'Topic (marketing)'},{key:'recipientReason',label:'Recipient reason (marketing)'},{key:'campaignKey',label:'Campaign key (required for marketing)'}];
    const f=node('form','','client-form compose-form'); const advanced=node('details','','compose-advanced'); advanced.append(node('summary','Marketing and campaign options','cursor-interaction'));
    for(const field of fields) {
      const label=node('label','','client-field'); label.append(node('span',field.label));
      const input=field.options?node('select'):field.key==='to'?node('textarea'):node('input'); input.className='form-control'; input.name=field.key; input.setAttribute('aria-label',field.label); input.required=!!field.required;
      if(input instanceof HTMLInputElement) input.type=field.type||'text';
      if(input instanceof HTMLTextAreaElement) input.rows=2;
      if(input instanceof HTMLSelectElement) for(const [value,text] of field.options!) {const o=node('option',text);o.value=value;input.append(o);}
      input.value=composeState[field.key]||''; input.oninput=()=>{composeState[field.key]=input.value;views.delete('drafts');}; label.append(input); if(field.hint)label.append(node('small',field.hint,'muted')); (['topic','recipientReason','campaignKey'].includes(field.key)?advanced:f).append(label);
    }
    const editor=node('div','','mail-editor'); editor.contentEditable='true'; editor.setAttribute('role','textbox'); editor.setAttribute('aria-label','Email body'); editor.setAttribute('aria-multiline','true');
    editor.append(DOMPurify.sanitize(composeState.html,{RETURN_DOM_FRAGMENT:true})); editor.oninput=()=>{composeState.html=editor.innerHTML;views.delete('drafts');};
    editor.addEventListener('paste',event=>{event.preventDefault();document.execCommand('insertText',false,event.clipboardData?.getData('text/plain')||'');});
    const formatting=node('div','','editor-toolbar');
    for(const [cmd,label] of [['bold','Bold'],['italic','Italic'],['insertUnorderedList','Bulleted list']]) { const b=button(label,()=>{editor.focus();document.execCommand(cmd);composeState.html=editor.innerHTML;}); b.onmousedown=e=>e.preventDefault(); formatting.append(b); }
    f.append(box('Body',formatting,editor),advanced);
    const review=button(composeAttempted?'Submitted. Check Sent before retrying':'Review email',async()=>{
      if(!f.reportValidity())return;
      if(!editor.textContent?.trim())throw new Error('Enter an email body');
      const mail:Row={...composeState,html:DOMPurify.sanitize(editor.innerHTML),to:composeState.to.split(/[,;\s]+/).map((s:string)=>s.trim()).filter(Boolean)};
      for(const key of ['topic','recipientReason','campaignKey']) if(!mail[key]?.trim()) delete mail[key];
      if(!mail.to.length) { if(!mail.campaignKey)throw new Error('Enter a recipient');delete mail.to; }
      const result=await host.call('mailly_client_send',{mail,dry_run:true,confirmed:false});
      if(result.eligibleCount === 0) throw new Error('No eligible recipients. Check subscriptions, suppressions, and duplicate sends.');
      const preview=node('div'); preview.append(pairs({'From':`${mail.fromName||''} <${mail.fromEmail}>`,'To':mail.to?.join(', ')||'Frozen campaign audience','Subject':mail.subject,'Type':status(mail.emailType),'Estimated email units':result.requiredEmailUnits ?? result.data?.requiredEmailUnits ?? mail.to?.length ?? '—'}),email(mail.html));
      if(typeof result.eligibleCount === 'number') preview.prepend(pairs({'Input recipients':result.inputCount,'Eligible':result.eligibleCount,'Duplicate addresses':result.duplicateCount,'Unsubscribed or suppressed':result.suppressedCount,'Already sent or queued':result.campaignClaimedCount,'Frequency capped':result.frequencyCappedCount,'Already received this topic':result.topicExcludedCount}));
      await confirm('Review and send email',preview,async()=>{
        if(composeAttempted) throw new Error('This email was already submitted. Check Sent before retrying.');
        composeAttempted=true; review.disabled=true; review.dataset.locked='true'; review.textContent='Submitted. Check Sent before retrying';
        try { await host.call('mailly_client_send',{mail,dry_run:false,confirmed:true}); }
        catch(e) { host.notice('Sending status is unconfirmed. Check Sent to avoid duplicate delivery.'); throw e; }
        composeState={to:'',fromEmail:mail.fromEmail,fromName:mail.fromName,subject:'',html:'',emailType:'transactional'}; composeAttempted=false; views.delete('compose');views.delete('drafts');await navigate('outbox',true); host.notice('Email submitted. Check Sent for delivery results.');
      },'Confirm send');
    },'btn-primary brand-action');
    review.disabled=composeAttempted||host.permissions().send===false;
    if(review.disabled)review.dataset.locked='true';
    f.append(review,node('p','Unsent content stays in this window when you switch sections.','muted'));
    f.onsubmit=e=>e.preventDefault(); p.append(f);
  }
  const composeButton=button('Compose',()=>navigate('compose'),'btn-primary brand-action nav-item');composeButton.dataset.route='compose';nav.append(composeButton);
  for(const [group,items] of groups) { const section=node('div','','nav-group');section.append(node('p',group,'nav-label'));for(const [route,title] of items){const b=button(title,()=>navigate(route),'btn-ghost nav-item');b.dataset.route=route;if(route===active)b.setAttribute('aria-current','page');section.append(b);}nav.append(section); }
  const admin=button('Workspace settings ↗',()=>host.openLink('https://mailly.site/app'),'btn-ghost nav-item workspace-link');nav.append(admin);
  (document.getElementById('mail-folder') as HTMLSelectElement).onchange=event=>{void navigate((event.target as HTMLSelectElement).value).catch(error=>host.notice(error.message));};
  document.getElementById('nav-toggle')!.onclick=()=>{const shell=document.getElementById('client-shell')!;shell.classList.toggle('nav-open');};
  return { refresh:()=>navigate(active,true), isInbox:()=>active==='inbox'||active==='quarantine', navigate,
    reset:()=>{views.clear();area.replaceChildren(node('p','Account changed. Select a page.','empty'));document.querySelectorAll('.client-dialog').forEach(d=>d.remove());composeState={to:'',fromEmail:'',fromName:'',subject:'',html:'',emailType:'transactional'};composeAttempted=false;},
    invalidate:()=>{views.delete('drafts');views.delete('outbox');},
  };
}
