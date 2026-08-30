/* =========================================================================
   LEDGER — personal finance tracker
   Plain JS, no build step. All data lives in localStorage on this device.
   ========================================================================= */

const STORAGE_KEY = 'ledger_app_data_v1';

/* ---------------------------------------------------------------------
   Transaction type -> cash direction for the account it's posted to.
   'in' = money arrives in the account, 'out' = money leaves it.
   Transfer and Adjustment are handled specially (see computeAccountDelta).
   These rules mirror the original workbook's notes: transfers, borrowing,
   lending and investing are not "income" or "expense" for budget purposes.
------------------------------------------------------------------------ */
const TYPE_DIRECTION = {
  'Income': 'in',
  'Expense': 'out',
  'Debt borrowed': 'in',
  'Debt repayment': 'out',
  'Loan EMI': 'out',
  'Savings': 'out',
  'Investment': 'out',
  'Refund/Reimbursement': 'in',
  'Money Lent': 'out',
  'Money Received - Lent': 'in',
  'Chit payout': 'in'
};
// Types that count as real spend / income for budget & dashboard totals
const SPEND_TYPES = ['Expense'];
const INCOME_TYPES = ['Income'];
const REFUND_TYPES = ['Refund/Reimbursement'];
const DEBT_TYPES = ['Debt repayment', 'Debt borrowed', 'Loan EMI'];
const LEND_TYPES = ['Money Lent', 'Money Received - Lent'];

/* ===================== State / storage ===================== */
const Store = {
  data: null,

  load(){
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){
      try{
        this.data = JSON.parse(raw);
        if(!this.data.meta) this.data.meta = { nextId: this._computeNextId(this.data) };
        if(!this.data.meta.updatedAt) this.data.meta.updatedAt = Date.now();
        return;
      }catch(e){ console.warn('Corrupt data, reseeding', e); }
    }
    this.data = structuredClone(SEED_DATA);
    this.data.recurringInstances = this.data.recurringInstances || [];
    this.data.meta = { nextId: this._computeNextId(this.data), updatedAt: Date.now() };
    this.save({ skipSync:true });
  },

  _computeNextId(d){
    let max = 0;
    ['transactions','friendFamily','debts','recurring','investments','accounts'].forEach(k=>{
      (d[k]||[]).forEach(item=>{
        const n = parseInt(String(item.id).replace(/[^0-9]/g,''),10);
        if(!isNaN(n) && n>max) max = n;
      });
    });
    return max+1;
  },

  save(opts){
    opts = opts || {};
    if(!this.data.meta) this.data.meta = {};
    if(!opts.skipTimestamp) this.data.meta.updatedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    if(!opts.skipSync && typeof DriveSync !== 'undefined') DriveSync.scheduleSync();
  },

  newId(prefix){
    if(!this.data.meta) this.data.meta = { nextId: 1 };
    const id = prefix + (this.data.meta.nextId++);
    return id;
  }
};

/* ===================== Small helpers ===================== */
function fmtMoney(n){
  if(n === null || n === undefined || isNaN(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return sign + '₹' + abs.toLocaleString('en-IN', { minimumFractionDigits: abs % 1 !== 0 ? 2 : 0, maximumFractionDigits: 2 });
}
function todayStr(){
  return new Date().toISOString().slice(0,10);
}
function monthKeyOf(dateStr){ return dateStr ? dateStr.slice(0,7) : ''; }
function currentMonthKey(){ return todayStr().slice(0,7); }
function monthLabel(mk){
  const [y,m] = mk.split('-').map(Number);
  return new Date(y, m-1, 1).toLocaleDateString('en-IN', { month:'long', year:'numeric' });
}
function dayLabel(dateStr){
  const d = new Date(dateStr+'T00:00:00');
  return d.toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short' });
}
function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function shiftMonthKey(mk, delta){
  let [y,m] = mk.split('-').map(Number);
  m += delta;
  while(m>12){ m-=12; y+=1; }
  while(m<1){ m+=12; y-=1; }
  return `${y}-${String(m).padStart(2,'0')}`;
}
function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(()=> el.classList.remove('show'), 2200);
}
function uniq(arr){ return [...new Set(arr)]; }

/* ===================== Derived data / computations ===================== */
function computeAccountDelta(t, accName){
  if(t.type === 'Transfer'){
    if(t.source === accName) return -t.amount;
    if(t.dest === accName) return t.amount;
    return 0;
  }
  if(t.source !== accName) return 0;
  if(t.type === 'Adjustment') return t.amount;
  const dir = TYPE_DIRECTION[t.type] || 'out';
  return dir === 'in' ? t.amount : -t.amount;
}

function accountBalance(accId){
  const acc = Store.data.accounts.find(a=>a.id===accId);
  if(!acc) return 0;
  let bal = Number(acc.openingBalance)||0;
  Store.data.transactions.forEach(t=>{ bal += computeAccountDelta(t, acc.name); });
  return Math.round(bal*100)/100;
}

function totalLiquid(){
  return Store.data.accounts.reduce((s,a)=>s+accountBalance(a.id),0);
}

// Net effect on "spend" for a category in a given month (Expense - Refunds)
function categorySpend(category, monthKey){
  return Store.data.transactions
    .filter(t=>t.category===category && monthKeyOf(t.date)===monthKey)
    .reduce((s,t)=>{
      if(SPEND_TYPES.includes(t.type)) return s + t.amount;
      if(REFUND_TYPES.includes(t.type)) return s - t.amount;
      return s;
    },0);
}

function monthTotals(monthKey){
  let income=0, expense=0, debtPaid=0, lentOut=0, investAmt=0;
  Store.data.transactions.filter(t=>monthKeyOf(t.date)===monthKey).forEach(t=>{
    if(INCOME_TYPES.includes(t.type)) income += t.amount;
    else if(SPEND_TYPES.includes(t.type)) expense += t.amount;
    else if(REFUND_TYPES.includes(t.type)) expense -= t.amount;
    if(t.type==='Debt repayment') debtPaid += t.amount;
    if(t.type==='Money Lent') lentOut += t.amount;
    if(t.type==='Investment') investAmt += t.amount;
  });
  return { income, expense, net: income-expense, debtPaid, lentOut, investAmt };
}

function totalDebtBalance(){
  return Store.data.debts.reduce((s,d)=> s + (typeof d.balance==='number' ? d.balance : 0), 0);
}
function totalOutstandingLending(){
  // positive = net amount owed TO the user; negative = user owes others
  let toMe=0, fromMe=0;
  Store.data.friendFamily.forEach(f=>{
    const outstanding = f.amount - (f.amountSettled||0);
    if(outstanding<=0) return;
    if(f.direction==='I Lent') toMe += outstanding; else fromMe += outstanding;
  });
  return { toMe, fromMe };
}

/* ===================== Router ===================== */
const ROUTES = ['dashboard','add','transactions','budget','debts','recurring','investments','more'];
let currentRoute = 'dashboard';
let uiState = { txnPage:1, txnFilters:{ q:'', month:'', account:'', type:'', category:'' }, budgetMonth:'', recurringMonth:'', editingTxnId:null };

function navigate(route){
  if(!ROUTES.includes(route)) route='dashboard';
  currentRoute = route;
  document.querySelectorAll('.navlink').forEach(b=>{
    b.classList.toggle('active', b.dataset.route===route);
  });
  const titles = { dashboard:'Dashboard', add:'Add entry', transactions:'Transactions', budget:'Budget',
    debts:'Debts & Lending', recurring:'Bills & Calendar', investments:'Investments', more:'More' };
  document.getElementById('topbarTitle').textContent = titles[route] || 'Ledger';
  render();
  document.getElementById('content').scrollTop = 0;
  window.scrollTo(0,0);
}

function render(){
  const el = document.getElementById('content');
  const renderers = {
    dashboard: renderDashboard, add: renderAdd, transactions: renderTransactions,
    budget: renderBudget, debts: renderDebts, recurring: renderRecurring,
    investments: renderInvestments, more: renderMore
  };
  el.innerHTML = (renderers[currentRoute] || renderDashboard)();
  attachRouteHandlers();
}

/* ===================== Dashboard ===================== */
function renderDashboard(){
  const mk = currentMonthKey();
  const mt = monthTotals(mk);
  const debt = totalDebtBalance();
  const lend = totalOutstandingLending();
  const accRows = Store.data.accounts.map(a=>{
    const bal = accountBalance(a.id);
    return `<div class="ledger-row">
      <span class="label">${escapeHtml(a.name)}</span><span class="fill"></span>
      <span class="amount neutral">${fmtMoney(bal)}</span>
    </div>`;
  }).join('');

  // upcoming bills (next 5 unpaid, soonest first)
  const upcoming = recurringUpcoming(mk).slice(0,5);
  const upcomingRows = upcoming.length ? upcoming.map(u=>`
    <div class="ledger-row">
      <span class="label">${escapeHtml(u.item)} ${u.dueDate ? `<span class="txn-meta">· ${dayLabel(u.dueDate)}</span>`:''}</span>
      <span class="fill"></span>
      <span class="amount neutral">${fmtMoney(u.expectedAmount)}</span>
    </div>`).join('') : `<p class="page-sub mt-0">Nothing due — you're all caught up.</p>`;

  // top budget categories this month
  const budgetRows = Store.data.budget.slice().map(b=>({...b, spend: categorySpend(b.category, mk)}))
    .sort((a,b)=>b.spend-a.spend).slice(0,4).map(b=>`
    <div class="ledger-row">
      <span class="label">${escapeHtml(b.category)}</span><span class="fill"></span>
      <span class="amount neutral">${fmtMoney(b.spend)}</span>
    </div>`).join('');

  return `
    <div class="hero-balance">
      <div class="hero-label">Total liquid money</div>
      <div class="hero-amount">${fmtMoney(totalLiquid())}</div>
      <div class="hero-sub">Across ${Store.data.accounts.length} accounts · as of today</div>
    </div>

    <div class="grid-3" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
      <div class="stat-tile"><div class="stat-label">In (this month)</div><div class="stat-value" style="color:var(--income)">${fmtMoney(mt.income)}</div></div>
      <div class="stat-tile"><div class="stat-label">Spent</div><div class="stat-value" style="color:var(--expense)">${fmtMoney(mt.expense)}</div></div>
      <div class="stat-tile"><div class="stat-label">Net</div><div class="stat-value">${fmtMoney(mt.net)}</div></div>
    </div>

    <div class="section-label">Accounts</div>
    <div class="card">${accRows}</div>

    <div class="section-label">Debts & lending</div>
    <div class="card">
      <div class="ledger-row"><span class="label">Total owed on debts/EMIs</span><span class="fill"></span><span class="amount neg">${fmtMoney(debt)}</span></div>
      <div class="ledger-row"><span class="label">Owed to you (friends/family)</span><span class="fill"></span><span class="amount pos">${fmtMoney(lend.toMe)}</span></div>
      <div class="ledger-row"><span class="label">You owe (friends/family)</span><span class="fill"></span><span class="amount neg">${fmtMoney(lend.fromMe)}</span></div>
    </div>

    <div class="section-label">Upcoming bills</div>
    <div class="card">${upcomingRows}</div>

    <div class="section-label">Top spending this month</div>
    <div class="card">${budgetRows || '<p class="page-sub mt-0">No spending recorded yet.</p>'}</div>
  `;
}

/* ===================== Add entry (Quick Entry) ===================== */
const ALL_TXN_TYPES = ['Expense','Income','Transfer','Debt repayment','Debt borrowed','Money Lent',
  'Money Received - Lent','Investment','Savings','Loan EMI','Chit payout','Refund/Reimbursement','Adjustment'];

function renderAdd(overrideValues){
  const editing = uiState.editingTxnId ? Store.data.transactions.find(t=>t.id===uiState.editingTxnId) : null;
  const t = overrideValues || editing || { date: todayStr(), type:'Expense', amount:'', source:'', dest:'', category:'', subcategory:'', description:'', paymentMethod:'', person:'', notes:'' };
  const accounts = Store.data.accounts;
  const cats = Object.keys(Store.data.settings.categorySubcategoryMap);
  const subcats = Store.data.settings.categorySubcategoryMap[t.category] || [];
  const needsDest = t.type === 'Transfer';
  const showCategory = !['Transfer'].includes(t.type);
  const showPerson = ['Money Lent','Money Received - Lent','Debt borrowed','Debt repayment'].includes(t.type);

  return `
    <h1 class="page-title">${editing ? 'Edit entry' : 'Add an entry'}</h1>
    <p class="page-sub">${editing ? 'Change the details below.' : 'One transaction per entry — this feeds everything else in the app.'}</p>

    <form id="txnForm">
      <div class="type-toggle" id="typeToggle">
        ${ALL_TXN_TYPES.map(tt=>`<button type="button" data-type="${tt}" class="${tt===t.type?'active':''}">${tt}</button>`).join('')}
      </div>
      <input type="hidden" id="f_type" value="${t.type}">

      <div class="row-2">
        <div class="field"><label>Date</label><input type="date" id="f_date" value="${t.date}" required></div>
        <div class="field"><label>Amount (₹)</label><input type="number" step="0.01" id="f_amount" value="${t.amount}" placeholder="0.00" required></div>
      </div>

      <div class="row-2">
        <div class="field"><label>${needsDest ? 'From account' : 'Account'}</label>
          <select id="f_source" required>
            <option value="">Select…</option>
            ${accounts.map(a=>`<option value="${escapeHtml(a.name)}" ${a.name===t.source?'selected':''}>${escapeHtml(a.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field" id="destField" style="${needsDest?'':'display:none'}"><label>To account</label>
          <select id="f_dest">
            <option value="">Select…</option>
            ${accounts.map(a=>`<option value="${escapeHtml(a.name)}" ${a.name===t.dest?'selected':''}>${escapeHtml(a.name)}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="row-2" id="categoryFields" style="${showCategory?'':'display:none'}">
        <div class="field"><label>Category</label>
          <select id="f_category">
            <option value="">Select…</option>
            ${cats.map(c=>`<option value="${escapeHtml(c)}" ${c===t.category?'selected':''}>${escapeHtml(c)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Subcategory</label>
          <select id="f_subcategory">
            <option value="">Select…</option>
            ${subcats.map(s=>`<option value="${escapeHtml(s)}" ${s===t.subcategory?'selected':''}>${escapeHtml(s)}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="field"><label>Description</label><input type="text" id="f_description" value="${escapeHtml(t.description)}" placeholder="e.g. Petrol, Lunch, Rent"></div>

      <div class="row-2">
        <div class="field"><label>Payment method</label>
          <select id="f_paymentMethod">
            <option value="">Select…</option>
            ${Store.data.settings.paymentMethods.map(p=>`<option value="${escapeHtml(p)}" ${p===t.paymentMethod?'selected':''}>${escapeHtml(p)}</option>`).join('')}
          </select>
        </div>
        <div class="field" id="personField" style="${showPerson?'':'display:none'}"><label>Person</label>
          <input type="text" id="f_person" value="${escapeHtml(t.person||'')}" list="peopleList" placeholder="Name">
          <datalist id="peopleList">${Store.data.settings.people.map(p=>`<option value="${escapeHtml(p)}">`).join('')}</datalist>
        </div>
      </div>

      <div class="field"><label>Notes</label><textarea id="f_notes">${escapeHtml(t.notes||'')}</textarea></div>

      <div class="btn-row">
        ${editing ? `<button type="button" class="btn btn-danger" id="deleteTxnBtn">Delete</button>` : ''}
        <button type="submit" class="btn">${editing ? 'Save changes' : 'Add entry'}</button>
      </div>
      ${editing ? `<button type="button" class="btn btn-ghost" id="cancelEditBtn" style="width:100%;margin-top:10px;">Cancel</button>` : ''}
    </form>
  `;
}

function collectTxnForm(){
  return {
    date: document.getElementById('f_date').value,
    amount: parseFloat(document.getElementById('f_amount').value),
    type: document.getElementById('f_type').value,
    source: document.getElementById('f_source').value,
    dest: document.getElementById('f_dest') ? document.getElementById('f_dest').value : '',
    category: document.getElementById('f_category') ? document.getElementById('f_category').value : '',
    subcategory: document.getElementById('f_subcategory') ? document.getElementById('f_subcategory').value : '',
    description: document.getElementById('f_description').value.trim(),
    paymentMethod: document.getElementById('f_paymentMethod').value,
    person: document.getElementById('f_person') ? document.getElementById('f_person').value.trim() : '',
    notes: document.getElementById('f_notes').value.trim()
  };
}

/* ===================== Transactions list ===================== */
function typeColor(type){
  if(SPEND_TYPES.includes(type)) return { bg:'var(--expense-soft)', fg:'var(--expense)', sign:'-' };
  if(INCOME_TYPES.includes(type) || REFUND_TYPES.includes(type)) return { bg:'var(--income-soft)', fg:'var(--income)', sign:'+' };
  if(type==='Transfer') return { bg:'var(--info-soft)', fg:'var(--info)', sign:'⇄' };
  if(DEBT_TYPES.includes(type)) return { bg:'var(--debt-soft)', fg:'var(--debt)', sign: type==='Debt borrowed'?'+':'-' };
  return { bg:'var(--info-soft)', fg:'var(--info)', sign:'' };
}

function filteredTransactions(){
  const f = uiState.txnFilters;
  return Store.data.transactions.filter(t=>{
    if(f.month && monthKeyOf(t.date)!==f.month) return false;
    if(f.account && t.source!==f.account && t.dest!==f.account) return false;
    if(f.type && t.type!==f.type) return false;
    if(f.category && (t.category||'No category')!==f.category) return false;
    if(f.q){
      const hay = `${t.description} ${t.notes} ${t.category} ${t.subcategory} ${t.person}`.toLowerCase();
      if(!hay.includes(f.q.toLowerCase())) return false;
    }
    return true;
  }).sort((a,b)=> b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

function signedAmount(t){
  if(t.type==='Transfer') return 0;
  if(t.type==='Adjustment') return t.amount;
  const dir = TYPE_DIRECTION[t.type] || 'out';
  return dir==='in' ? t.amount : -t.amount;
}

function renderTransactions(){
  const all = filteredTransactions();
  const pageSize = 25;
  const shown = all.slice(0, pageSize * uiState.txnPage);
  const months = uniq(Store.data.transactions.map(t=>monthKeyOf(t.date))).sort().reverse();
  const accounts = Store.data.accounts.map(a=>a.name);
  const categories = uniq(Store.data.transactions.map(t=>t.category||'No category')).sort((a,b)=>a.localeCompare(b));

  let rows = '';
  if(shown.length===0){
    rows = `<div class="empty-state"><span class="ni">≡</span>No transactions match. Try clearing filters.</div>`;
  } else {
    let lastDay = null;
    shown.forEach(t=>{
      if(t.date !== lastDay){
        lastDay = t.date;
        rows += `<div class="day-divider"><span>${dayLabel(t.date)}</span></div>`;
      }
      rows += txnItemHtml(t);
    });
  }

  // Spend total for whatever is currently filtered (this is what answers "how much did I spend on X")
  const filteredTotal = all.reduce((s,t)=>s+signedAmount(t),0);
  const hasFilter = uiState.txnFilters.month || uiState.txnFilters.account || uiState.txnFilters.type || uiState.txnFilters.category || uiState.txnFilters.q;

  return `
    <h1 class="page-title">Transactions</h1>
    <p class="page-sub">${all.length} entr${all.length===1?'y':'ies'}${uiState.txnFilters.month ? ' in '+monthLabel(uiState.txnFilters.month) : ''}</p>

    ${hasFilter ? `<div class="stat-tile" style="margin-bottom:12px;">
        <div class="stat-label">Net for this filter</div>
        <div class="stat-value ${filteredTotal>=0?'':''}" style="color:${filteredTotal>=0?'var(--income)':'var(--expense)'}">${filteredTotal>=0?'+':''}${fmtMoney(filteredTotal)}</div>
      </div>` : ''}

    <div class="search-bar">
      <span>🔍</span>
      <input type="text" id="txnSearch" placeholder="Search description, notes, person…" value="${escapeHtml(uiState.txnFilters.q)}">
    </div>
    <div class="filter-chips">
      <select class="chip-select" id="filterMonth">
        <option value="">All months</option>
        ${months.map(m=>`<option value="${m}" ${m===uiState.txnFilters.month?'selected':''}>${monthLabel(m)}</option>`).join('')}
      </select>
      <select class="chip-select" id="filterAccount">
        <option value="">All accounts</option>
        ${accounts.map(a=>`<option value="${escapeHtml(a)}" ${a===uiState.txnFilters.account?'selected':''}>${escapeHtml(a)}</option>`).join('')}
      </select>
      <select class="chip-select" id="filterType">
        <option value="">All types</option>
        ${ALL_TXN_TYPES.map(tt=>`<option value="${tt}" ${tt===uiState.txnFilters.type?'selected':''}>${tt}</option>`).join('')}
      </select>
      <select class="chip-select" id="filterCategory">
        <option value="">All categories</option>
        ${categories.map(c=>`<option value="${escapeHtml(c)}" ${c===uiState.txnFilters.category?'selected':''}>${escapeHtml(c)}</option>`).join('')}
      </select>
    </div>

    <div class="card" style="padding:6px 12px;">${rows}</div>
    ${sortMode==='date' && all.length > shownCount ? `<button class="btn btn-secondary" id="loadMoreBtn" style="margin-top:12px;">Load more (${all.length - shownCount} left)</button>` : ''}
  `;
}

function txnItemHtml(t){
  const c = typeColor(t.type);
  return `<div class="txn-item" data-id="${t.id}">
    <div class="txn-icon" style="background:${c.bg};color:${c.fg}">${(t.category||t.type||'?').slice(0,1)}</div>
    <div class="txn-mid">
      <div class="txn-desc">${escapeHtml(t.description || t.type)}</div>
      <div class="txn-meta">${dayLabel(t.date)} · ${escapeHtml(t.type)}${t.source?' · '+escapeHtml(t.source):''}</div>
    </div>
    <div class="txn-amount" style="color:${c.fg}">${c.sign}${fmtMoney(Math.abs(t.amount))}</div>
  </div>`;
}

/* ===================== Budget ===================== */
function renderBudget(){
  const mk = uiState.budgetMonth || currentMonthKey();
  const rows = Store.data.budget.map(b=>{
    const spend = categorySpend(b.category, mk);
    const budget = b.monthlyBudget;
    const pct = budget ? Math.min(100, (spend/budget)*100) : 0;
    const over = budget && spend > budget;
    return `
      <div class="card" data-cat="${escapeHtml(b.category)}">
        <div class="flex-between">
          <div>
            <strong>${escapeHtml(b.category)}</strong>
            <span class="badge ${b.importance==='Essential'?'badge-info':b.importance==='Important'?'badge-debt':'badge-expense'}" style="margin-left:6px;">${escapeHtml(b.importance)}</span>
          </div>
          <span class="amount neutral">${fmtMoney(spend)}</span>
        </div>
        ${budget ? `<div class="progress-track"><div class="progress-fill ${over?'over':''}" style="width:${pct}%"></div></div>
        <div class="txn-meta" style="margin-top:6px;">${over ? `Over by ${fmtMoney(spend-budget)}` : `${fmtMoney(budget-spend)} left of ${fmtMoney(budget)}`}</div>`
        : `<div class="txn-meta" style="margin-top:6px;">No monthly budget set</div>`}
        <button type="button" class="btn-ghost setBudgetBtn" style="margin-top:10px;" data-cat="${escapeHtml(b.category)}">Set monthly budget</button>
      </div>`;
  }).join('');

  const totalSpend = Store.data.budget.reduce((s,b)=>s+categorySpend(b.category, mk),0);
  const totalBudget = Store.data.budget.reduce((s,b)=>s+(b.monthlyBudget||0),0);

  return `
    <h1 class="page-title">Budget</h1>
    <div class="flex-between page-sub">
      <button class="icon-btn" id="budgetPrev">‹</button>
      <span>${monthLabel(mk)}</span>
      <button class="icon-btn" id="budgetNext">›</button>
    </div>
    <div class="grid-2">
      <div class="stat-tile"><div class="stat-label">Spent</div><div class="stat-value" style="color:var(--expense)">${fmtMoney(totalSpend)}</div></div>
      <div class="stat-tile"><div class="stat-label">Budgeted</div><div class="stat-value">${fmtMoney(totalBudget)}</div></div>
    </div>
    <div class="section-label">By category</div>
    ${rows}
  `;
}

/* ===================== Debts & Lending ===================== */
function renderDebts(){
  const tab = uiState.debtsTab || 'debts';
  const debtRows = Store.data.debts.map(d=>`
    <div class="card">
      <div class="flex-between">
        <strong>${escapeHtml(d.name)}</strong>
        <span class="amount neg">${d.balance!=null ? fmtMoney(d.balance) : 'TBD'}</span>
      </div>
      <div class="txn-meta" style="margin-top:4px;">${d.dueDay ? `Due day ${d.dueDay} of each month` : 'Due date not set'}${d.interestRate?' · '+escapeHtml(String(d.interestRate)):''}</div>
      <div class="btn-row" style="margin-top:12px;">
        <button class="btn-secondary logPaymentBtn" style="flex:1;padding:9px;border-radius:8px;" data-id="${d.id}">Log payment</button>
        <button class="btn-ghost editDebtBtn" data-id="${d.id}">Edit</button>
      </div>
    </div>`).join('') + `<button class="btn btn-secondary" id="addDebtBtn" style="margin-top:6px;">+ Add a debt / EMI</button>`;

  const lend = totalOutstandingLending();
  const ffRows = Store.data.friendFamily.map(f=>{
    const outstanding = f.amount - (f.amountSettled||0);
    return `
    <div class="card">
      <div class="flex-between">
        <strong>${escapeHtml(f.person)}</strong>
        <span class="badge ${f.direction==='I Lent'?'badge-income':'badge-debt'}">${escapeHtml(f.direction)}</span>
      </div>
      <div class="ledger-row"><span class="label">${escapeHtml(f.reason||'—')} · ${f.date}</span><span class="fill"></span><span class="amount neutral">${fmtMoney(f.amount)}</span></div>
      <div class="txn-meta">Outstanding: ${fmtMoney(outstanding)} ${outstanding<=0?'· Settled':''}</div>
      ${outstanding>0 ? `<button class="btn-secondary settleBtn" style="margin-top:10px;width:100%;padding:9px;border-radius:8px;" data-id="${f.id}">Settle / record payment</button>` : ''}
    </div>`;
  }).join('') + `<button class="btn btn-secondary" id="addLendBtn" style="margin-top:6px;">+ Add lending / borrowing</button>`;

  const chit = Store.data.chit;
  const chitCard = `
    <div class="card">
      <div class="flex-between"><strong>Chit Fund</strong><span class="badge badge-debt">${escapeHtml(chit.payoutStatus)}</span></div>
      <div class="ledger-row"><span class="label">Members</span><span class="fill"></span><span class="amount neutral">${chit.members}</span></div>
      <div class="ledger-row"><span class="label">Contribution</span><span class="fill"></span><span class="amount neutral">${fmtMoney(chit.contribution)}</span></div>
      <div class="ledger-row"><span class="label">Payout</span><span class="fill"></span><span class="amount pos">${fmtMoney(chit.payout)}</span></div>
      <div class="ledger-row"><span class="label">Contributions remaining</span><span class="fill"></span><span class="amount neutral">${chit.contributionsRemaining}</span></div>
      <button class="btn-secondary" id="chitContribBtn" style="margin-top:10px;width:100%;padding:9px;border-radius:8px;">Log a contribution</button>
    </div>`;

  return `
    <h1 class="page-title">Debts & Lending</h1>
    <div class="tabs">
      <button data-tab="debts" class="${tab==='debts'?'active':''}">Debts & EMI</button>
      <button data-tab="family" class="${tab==='family'?'active':''}">Friends/Family</button>
      <button data-tab="chit" class="${tab==='chit'?'active':''}">Chit Fund</button>
    </div>
    ${tab==='debts' ? debtRows : ''}
    ${tab==='family' ? `<div class="grid-2" style="margin-bottom:12px;">
        <div class="stat-tile"><div class="stat-label">Owed to you</div><div class="stat-value" style="color:var(--income)">${fmtMoney(lend.toMe)}</div></div>
        <div class="stat-tile"><div class="stat-label">You owe</div><div class="stat-value" style="color:var(--expense)">${fmtMoney(lend.fromMe)}</div></div>
      </div>${ffRows}` : ''}
    ${tab==='chit' ? chitCard : ''}
  `;
}

/* ===================== Recurring bills & calendar ===================== */
function recurringUpcoming(monthKey){
  return Store.data.recurring.map(r=>{
    const inst = Store.data.recurringInstances.find(i=>i.recurringId===r.id && i.month===monthKey);
    const dueDate = r.dueDay ? `${monthKey}-${String(r.dueDay).padStart(2,'0')}` : null;
    const daysRemaining = dueDate ? Math.round((new Date(dueDate) - new Date(todayStr()))/86400000) : null;
    return {
      ...r, dueDate, daysRemaining,
      paid: inst ? inst.paid : false,
      actualAmount: inst ? inst.actualAmount : null,
      expectedAmount: r.expectedAmount
    };
  }).filter(r=>!r.paid).sort((a,b)=>{
    if(a.daysRemaining==null) return 1;
    if(b.daysRemaining==null) return -1;
    return a.daysRemaining - b.daysRemaining;
  });
}

function renderRecurring(){
  const mk = uiState.recurringMonth || currentMonthKey();
  const items = Store.data.recurring.map(r=>{
    const inst = Store.data.recurringInstances.find(i=>i.recurringId===r.id && i.month===mk);
    const dueDate = r.dueDay ? `${mk}-${String(r.dueDay).padStart(2,'0')}` : null;
    const daysRemaining = dueDate ? Math.round((new Date(dueDate) - new Date(todayStr()))/86400000) : null;
    const paid = inst ? inst.paid : false;
    return `
      <div class="card">
        <div class="flex-between">
          <strong>${escapeHtml(r.item)}</strong>
          ${paid ? '<span class="badge badge-income">Paid</span>' : (daysRemaining!=null && daysRemaining<0 ? '<span class="badge badge-expense">Overdue</span>' : '<span class="badge badge-debt">Unpaid</span>')}
        </div>
        <div class="txn-meta" style="margin:4px 0;">${escapeHtml(r.category)} ${dueDate ? '· due '+dayLabel(dueDate) : '· no due date set'}</div>
        <div class="ledger-row"><span class="label">Expected</span><span class="fill"></span><span class="amount neutral">${fmtMoney(r.expectedAmount)}</span></div>
        ${paid ? `<div class="ledger-row"><span class="label">Actually paid</span><span class="fill"></span><span class="amount neutral">${fmtMoney(inst.actualAmount)}</span></div>` : ''}
        <div class="btn-row" style="margin-top:10px;">
          ${!paid ? `<button class="btn-secondary markPaidBtn" style="flex:1;padding:9px;border-radius:8px;" data-id="${r.id}">Mark paid</button>` : ''}
          <button class="btn-ghost editRecurringBtn" data-id="${r.id}">Edit</button>
        </div>
      </div>`;
  }).join('');

  return `
    <h1 class="page-title">Bills & Calendar</h1>
    <div class="flex-between page-sub">
      <button class="icon-btn" id="recurPrev">‹</button>
      <span>${monthLabel(mk)}</span>
      <button class="icon-btn" id="recurNext">›</button>
    </div>
    ${items}
    <button class="btn btn-secondary" id="addRecurringBtn" style="margin-top:6px;">+ Add a recurring bill</button>
  `;
}

/* ===================== Investments ===================== */
function renderInvestments(){
  let totalValue=0, totalInvested=0;
  const rows = Store.data.investments.map(inv=>{
    const invested = (inv.originalInvested||0) + (inv.additional||0) - (inv.withdrawals||0);
    const gain = (inv.currentValue!=null && inv.originalInvested!=null) ? inv.currentValue - invested : null;
    if(inv.currentValue) totalValue += inv.currentValue;
    if(invested) totalInvested += invested;
    return `
      <div class="card">
        <div class="flex-between"><strong>${escapeHtml(inv.name)}</strong><span class="badge badge-info">${escapeHtml(inv.type)}</span></div>
        <div class="ledger-row"><span class="label">Invested</span><span class="fill"></span><span class="amount neutral">${inv.originalInvested!=null?fmtMoney(invested):'TBD'}</span></div>
        <div class="ledger-row"><span class="label">Current value</span><span class="fill"></span><span class="amount neutral">${inv.currentValue!=null?fmtMoney(inv.currentValue):'TBD'}</span></div>
        ${gain!=null ? `<div class="ledger-row"><span class="label">Gain/Loss</span><span class="fill"></span><span class="amount ${gain>=0?'pos':'neg'}">${gain>=0?'+':''}${fmtMoney(gain)}</span></div>` : ''}
        ${inv.notes ? `<div class="txn-meta" style="margin-top:6px;">${escapeHtml(inv.notes)}</div>` : ''}
        <button class="btn-ghost updateValueBtn" style="margin-top:10px;" data-id="${inv.id}">Update value</button>
      </div>`;
  }).join('');

  return `
    <h1 class="page-title">Investments</h1>
    <div class="grid-2">
      <div class="stat-tile"><div class="stat-label">Total invested</div><div class="stat-value">${fmtMoney(totalInvested)}</div></div>
      <div class="stat-tile"><div class="stat-label">Current value</div><div class="stat-value">${fmtMoney(totalValue)}</div></div>
    </div>
    <p class="page-sub" style="margin-top:10px;">Investment value isn't counted as liquid cash on your Dashboard.</p>
    ${rows}
    <button class="btn btn-secondary" id="addInvestmentBtn" style="margin-top:6px;">+ Add an investment</button>
  `;
}

/* ===================== More / Settings ===================== */
function renderMore(){
  const accRows = Store.data.accounts.map(a=>`
    <div class="ledger-row">
      <span class="label">${escapeHtml(a.name)} <span class="txn-meta">(opening ${fmtMoney(a.openingBalance)})</span></span>
      <span class="fill"></span>
      <span class="amount neutral">${fmtMoney(accountBalance(a.id))}</span>
    </div>`).join('');

  const ds = DriveSync.getStatus();
  const signedIn = DriveSync.isSignedIn();
  const configured = DriveSync.isConfigured();
  const dotColor = ds.state==='idle' ? 'var(--income)' : ds.state==='error' ? 'var(--expense)' : ds.state==='syncing'||ds.state==='pending' ? 'var(--debt)' : 'var(--text-faint)';
  const lastSyncText = ds.lastSync ? new Date(ds.lastSync).toLocaleString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : 'never';

  return `
    <h1 class="page-title">More</h1>

    <div class="section-label">Sync across devices</div>
    <div class="card">
      ${!configured ? `
        <p class="page-sub mt-0">Not set up yet. Follow "Setting up Google Drive sync" in the README to connect this app to your Google Drive, then your phone and laptop will stay in sync automatically.</p>
      ` : `
        <div class="flex-between">
          <div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotColor};margin-right:8px;"></span>${escapeHtml(ds.message)}</div>
        </div>
        <div class="txn-meta" style="margin-top:6px;">Last synced: ${lastSyncText}</div>
        <div class="btn-row" style="margin-top:12px;">
          ${signedIn
            ? `<button class="btn-secondary" id="syncNowBtn" style="flex:1;">Sync now</button><button class="btn-ghost" id="signOutBtn">Sign out</button>`
            : `<button class="btn" id="signInBtn">Sign in with Google</button>`}
        </div>
      `}
    </div>

    <div class="section-label">Accounts</div>
    <div class="card">${accRows}
      <button class="btn-ghost" id="addAccountBtn" style="margin-top:10px;">+ Add account</button>
    </div>

    <div class="section-label">Categories</div>
    <div class="card">
      <p class="page-sub mt-0">Edit which subcategories show up when you add an entry.</p>
      <div class="field"><label>Category</label>
        <select id="catEditorSelect">
          ${Object.keys(Store.data.settings.categorySubcategoryMap).map(c=>`<option value="${escapeHtml(c)}" ${c===(uiState.catEditorCat||Object.keys(Store.data.settings.categorySubcategoryMap)[0])?'selected':''}>${escapeHtml(c)}</option>`).join('')}
        </select>
      </div>
      <div id="subcatList"></div>
      <div class="row-2" style="margin-top:10px;">
        <input type="text" id="newSubcatInput" placeholder="New subcategory name" style="grid-column:span 1;background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-s);padding:11px 12px;">
        <button class="btn-secondary" id="addSubcatBtn">Add</button>
      </div>
    </div>

    <div class="section-label">Your data</div>
    <div class="card">
      <p class="page-sub mt-0">Everything is stored only on this device's browser storage. Back up regularly, especially before switching phones.</p>
      <div class="btn-row">
        <button class="btn-secondary" id="exportBtn">Export backup</button>
        <button class="btn-secondary" id="importBtn">Import backup</button>
      </div>
      <input type="file" id="importFile" accept="application/json" style="display:none;">
      <button class="btn-danger" id="resetBtn" style="margin-top:12px;width:100%;">Reset all data</button>
    </div>

    <div class="section-label">About</div>
    <div class="card">
      <p class="page-sub mt-0">Ledger v1 — a personal finance tracker. Install this page to your home screen for the full app feel (share/menu → "Add to Home Screen").</p>
    </div>
  `;
}

/* ===================== Event wiring ===================== */
function attachRouteHandlers(){
  if(currentRoute === 'add') wireAddPage();
  if(currentRoute === 'transactions') wireTransactionsPage();
  if(currentRoute === 'budget') wireBudgetPage();
  if(currentRoute === 'debts') wireDebtsPage();
  if(currentRoute === 'recurring') wireRecurringPage();
  if(currentRoute === 'investments') wireInvestmentsPage();
  if(currentRoute === 'more') wireMorePage();
}

function wireAddPage(){
  const toggle = document.getElementById('typeToggle');
  toggle.querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.getElementById('f_type').value = btn.dataset.type;
      // preserve amount/date/description across type switch by re-rendering with them injected
      const preserved = collectTxnForm();
      preserved.type = btn.dataset.type;
      const existing = uiState.editingTxnId ? Store.data.transactions.find(t=>t.id===uiState.editingTxnId) : null;
      const merged = Object.assign({}, existing, preserved);
      if(!uiState.editingTxnId){
        // stash a temp draft so re-render keeps values
        uiState._draft = merged;
      }
      renderAddWithDraft(merged);
    });
  });

  const form = document.getElementById('txnForm');
  form.addEventListener('submit', e=>{
    e.preventDefault();
    const vals = collectTxnForm();
    if(!vals.source){ toast('Choose an account'); return; }
    if(vals.type==='Transfer' && !vals.dest){ toast('Choose a destination account'); return; }
    if(isNaN(vals.amount) || (vals.type!=='Adjustment' && vals.amount<=0)){ toast('Enter a valid amount'); return; }

    if(uiState.editingTxnId){
      const t = Store.data.transactions.find(x=>x.id===uiState.editingTxnId);
      Object.assign(t, vals);
      toast('Entry updated');
    } else {
      const t = { id: Store.newId('t'), ...vals };
      Store.data.transactions.push(t);
      toast('Entry added');
    }
    Store.save();
    uiState.editingTxnId = null;
    uiState._draft = null;
    navigate('transactions');
  });

  const delBtn = document.getElementById('deleteTxnBtn');
  if(delBtn) delBtn.addEventListener('click', ()=>{
    if(confirm('Delete this entry? This cannot be undone.')){
      Store.data.transactions = Store.data.transactions.filter(x=>x.id!==uiState.editingTxnId);
      Store.save();
      uiState.editingTxnId = null;
      toast('Entry deleted');
      navigate('transactions');
    }
  });
  const cancelBtn = document.getElementById('cancelEditBtn');
  if(cancelBtn) cancelBtn.addEventListener('click', ()=>{ uiState.editingTxnId=null; navigate('transactions'); });

  const catSel = document.getElementById('f_category');
  if(catSel) catSel.addEventListener('change', ()=>{
    const subs = Store.data.settings.categorySubcategoryMap[catSel.value] || [];
    const subSel = document.getElementById('f_subcategory');
    subSel.innerHTML = `<option value="">Select…</option>` + subs.map(s=>`<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  });
}

function renderAddWithDraft(draft){
  const el = document.getElementById('content');
  el.innerHTML = renderAdd(draft);
  attachRouteHandlers();
}

function wireTransactionsPage(){
  document.getElementById('txnSearch').addEventListener('input', e=>{
    uiState.txnFilters.q = e.target.value; uiState.txnPage=1; render();
  });
  document.getElementById('filterMonth').addEventListener('change', e=>{ uiState.txnFilters.month=e.target.value; uiState.txnPage=1; render(); });
  document.getElementById('filterAccount').addEventListener('change', e=>{ uiState.txnFilters.account=e.target.value; uiState.txnPage=1; render(); });
  document.getElementById('filterType').addEventListener('change', e=>{ uiState.txnFilters.type=e.target.value; uiState.txnPage=1; render(); });
  document.getElementById('filterCategory').addEventListener('change', e=>{ uiState.txnFilters.category=e.target.value; uiState.txnPage=1; render(); });
  const loadMore = document.getElementById('loadMoreBtn');
  if(loadMore) loadMore.addEventListener('click', ()=>{ uiState.txnPage++; render(); });
  document.querySelectorAll('.txn-item').forEach(item=>{
    item.addEventListener('click', ()=>{
      uiState.editingTxnId = item.dataset.id;
      navigate('add');
    });
  });
}

function wireBudgetPage(){
  document.getElementById('budgetPrev').addEventListener('click', ()=>{
    uiState.budgetMonth = shiftMonthKey(uiState.budgetMonth||currentMonthKey(), -1); render();
  });
  document.getElementById('budgetNext').addEventListener('click', ()=>{
    uiState.budgetMonth = shiftMonthKey(uiState.budgetMonth||currentMonthKey(), 1); render();
  });
  document.querySelectorAll('.setBudgetBtn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const b = Store.data.budget.find(x=>x.category===btn.dataset.cat);
      const val = prompt(`Monthly budget for ${b.category} (₹):`, b.monthlyBudget||'');
      if(val===null) return;
      const num = parseFloat(val);
      b.monthlyBudget = isNaN(num) ? null : num;
      Store.save(); render();
    });
  });
}

function wireDebtsPage(){
  document.querySelectorAll('.tabs button[data-tab]').forEach(btn=>{
    btn.addEventListener('click', ()=>{ uiState.debtsTab = btn.dataset.tab; render(); });
  });
  document.querySelectorAll('.logPaymentBtn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const d = Store.data.debts.find(x=>x.id===btn.dataset.id);
      const val = prompt(`Payment amount for ${d.name} (₹):`, d.balance || '');
      if(val===null) return;
      const amt = parseFloat(val);
      if(isNaN(amt) || amt<=0){ toast('Enter a valid amount'); return; }
      const accName = pickAccount(`Pay from which account?`);
      if(!accName) return;
      Store.data.transactions.push({ id: Store.newId('t'), date: todayStr(), amount: amt, type:'Debt repayment',
        source: accName, dest:'', category:'Debt & Loans', subcategory: d.name, description:`${d.name} payment`,
        paymentMethod:'', person:'', notes:'' });
      if(typeof d.balance === 'number') d.balance = Math.max(0, d.balance - amt);
      Store.save(); toast('Payment logged'); render();
    });
  });
  document.querySelectorAll('.editDebtBtn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const d = Store.data.debts.find(x=>x.id===btn.dataset.id);
      const bal = prompt(`Update balance for ${d.name} (₹):`, d.balance ?? '');
      if(bal!==null){ const n=parseFloat(bal); d.balance = isNaN(n)?null:n; }
      const due = prompt(`Due day of month (1-31, blank if unknown):`, d.dueDay ?? '');
      if(due!==null){ const n=parseInt(due,10); d.dueDay = isNaN(n)?null:n; }
      Store.save(); render();
    });
  });
  const addDebtBtn = document.getElementById('addDebtBtn');
  if(addDebtBtn) addDebtBtn.addEventListener('click', ()=>{
    const name = prompt('Debt / lender name:'); if(!name) return;
    const bal = parseFloat(prompt('Current balance (₹):','')||'');
    const due = parseInt(prompt('Due day of month (1-31, optional):','')||'',10);
    Store.data.debts.push({ id: Store.newId('d'), name, balance:isNaN(bal)?null:bal, dueDay:isNaN(due)?null:due, interestRate:null, notes:'' });
    Store.save(); toast('Debt added'); render();
  });

  document.querySelectorAll('.settleBtn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const f = Store.data.friendFamily.find(x=>x.id===btn.dataset.id);
      const outstanding = f.amount - (f.amountSettled||0);
      const val = prompt(`Amount settled now (₹):`, outstanding);
      if(val===null) return;
      const amt = parseFloat(val);
      if(isNaN(amt) || amt<=0){ toast('Enter a valid amount'); return; }
      const accName = pickAccount(f.direction==='I Lent' ? 'Receiving into which account?' : 'Paying from which account?');
      if(!accName) return;
      f.amountSettled = (f.amountSettled||0) + amt;
      f.settlementDate = todayStr();
      if(f.amount - f.amountSettled <= 0) f.status = 'Settled';
      Store.data.transactions.push({ id: Store.newId('t'), date: todayStr(), amount: amt,
        type: f.direction==='I Lent' ? 'Money Received - Lent' : 'Debt repayment',
        source: accName, dest:'', category:'', subcategory:'', description:`${f.person} settlement`,
        paymentMethod:'', person: f.person, notes:'' });
      Store.save(); toast('Recorded'); render();
    });
  });
  const addLendBtn = document.getElementById('addLendBtn');
  if(addLendBtn) addLendBtn.addEventListener('click', ()=>{
    const person = prompt('Person name:'); if(!person) return;
    const direction = confirm('Click OK for "I Lent" (you gave money), or Cancel for "Borrowed from" (you received money).') ? 'I Lent' : 'Borrowed from';
    const amt = parseFloat(prompt('Amount (₹):','')||'');
    if(isNaN(amt) || amt<=0){ toast('Enter a valid amount'); return; }
    const reason = prompt('Reason (optional):','')||'';
    const accName = pickAccount(direction==='I Lent' ? 'Paying from which account?' : 'Receiving into which account?');
    if(!accName) return;
    Store.data.friendFamily.push({ id: Store.newId('f'), person, direction, date: todayStr(), amount: amt,
      reason, amountSettled:0, settlementDate:null, status:'Outstanding', notes:'' });
    Store.data.transactions.push({ id: Store.newId('t'), date: todayStr(), amount: amt,
      type: direction==='I Lent' ? 'Money Lent' : 'Debt borrowed',
      source: accName, dest:'', category:'', subcategory:'', description:`${direction==='I Lent'?'Lent to':'Borrowed from'} ${person}`,
      paymentMethod:'', person, notes: reason });
    Store.save(); toast('Saved'); render();
  });

  const chitBtn = document.getElementById('chitContribBtn');
  if(chitBtn) chitBtn.addEventListener('click', ()=>{
    const chit = Store.data.chit;
    const accName = pickAccount('Pay contribution from which account?');
    if(!accName) return;
    Store.data.transactions.push({ id: Store.newId('t'), date: todayStr(), amount: chit.contribution,
      type:'Investment', source: accName, dest:'', category:'Financial', subcategory:'Chit contribution',
      description:'Chit contribution', paymentMethod:'', person:'', notes:'' });
    if(chit.contributionsRemaining>0) chit.contributionsRemaining -= 1;
    Store.save(); toast('Contribution logged'); render();
  });
}

function wireRecurringPage(){
  document.getElementById('recurPrev').addEventListener('click', ()=>{ uiState.recurringMonth = shiftMonthKey(uiState.recurringMonth||currentMonthKey(), -1); render(); });
  document.getElementById('recurNext').addEventListener('click', ()=>{ uiState.recurringMonth = shiftMonthKey(uiState.recurringMonth||currentMonthKey(), 1); render(); });
  document.querySelectorAll('.markPaidBtn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const r = Store.data.recurring.find(x=>x.id===btn.dataset.id);
      const mk = uiState.recurringMonth || currentMonthKey();
      const val = prompt(`Amount paid for ${r.item} (₹):`, r.expectedAmount||'');
      if(val===null) return;
      const amt = parseFloat(val);
      if(isNaN(amt) || amt<=0){ toast('Enter a valid amount'); return; }
      const accName = pickAccount('Pay from which account?');
      if(!accName) return;
      Store.data.transactions.push({ id: Store.newId('t'), date: todayStr(), amount: amt, type:'Expense',
        source: accName, dest:'', category: r.category, subcategory: r.item, description: r.item,
        paymentMethod:'', person:'', notes:'' });
      let inst = Store.data.recurringInstances.find(i=>i.recurringId===r.id && i.month===mk);
      if(!inst){ inst = { recurringId:r.id, month:mk }; Store.data.recurringInstances.push(inst); }
      inst.paid = true; inst.actualAmount = amt; inst.paidDate = todayStr();
      Store.save(); toast('Marked paid'); render();
    });
  });
  document.querySelectorAll('.editRecurringBtn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const r = Store.data.recurring.find(x=>x.id===btn.dataset.id);
      const amt = prompt(`Expected amount for ${r.item} (₹):`, r.expectedAmount ?? '');
      if(amt!==null){ const n=parseFloat(amt); r.expectedAmount = isNaN(n)?null:n; }
      const due = prompt(`Due day of month (1-31):`, r.dueDay ?? '');
      if(due!==null){ const n=parseInt(due,10); r.dueDay = isNaN(n)?null:n; }
      Store.save(); render();
    });
  });
  const addBtn = document.getElementById('addRecurringBtn');
  if(addBtn) addBtn.addEventListener('click', ()=>{
    const item = prompt('Bill name:'); if(!item) return;
    const category = prompt('Category:', 'Housing & Household')||'Other';
    const amt = parseFloat(prompt('Expected amount (₹):','')||'');
    const due = parseInt(prompt('Due day of month (1-31, optional):','')||'',10);
    Store.data.recurring.push({ id: Store.newId('r'), item, category, expectedAmount:isNaN(amt)?null:amt, dueDay:isNaN(due)?null:due, priority:'', notes:'', account:'' });
    Store.save(); toast('Added'); render();
  });
}

function wireInvestmentsPage(){
  document.querySelectorAll('.updateValueBtn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const inv = Store.data.investments.find(x=>x.id===btn.dataset.id);
      const val = prompt(`Current value of ${inv.name} (₹):`, inv.currentValue ?? '');
      if(val===null) return;
      const n = parseFloat(val);
      inv.currentValue = isNaN(n)?null:n;
      Store.save(); toast('Updated'); render();
    });
  });
  const addBtn = document.getElementById('addInvestmentBtn');
  if(addBtn) addBtn.addEventListener('click', ()=>{
    const name = prompt('Investment name:'); if(!name) return;
    const type = prompt('Type (Mutual Fund / Gold/Commodity / Stocks / ETF / Other):','Mutual Fund')||'Other';
    const orig = parseFloat(prompt('Original invested (₹):','')||'');
    const cur = parseFloat(prompt('Current value (₹):','')||'');
    Store.data.investments.push({ id: Store.newId('i'), name, type, purchaseDate:null,
      originalInvested:isNaN(orig)?null:orig, additional:0, withdrawals:0, currentValue:isNaN(cur)?null:cur, notes:'' });
    Store.save(); toast('Added'); render();
  });
}

function renderSubcatList(){
  const cat = uiState.catEditorCat || Object.keys(Store.data.settings.categorySubcategoryMap)[0];
  const subs = Store.data.settings.categorySubcategoryMap[cat] || [];
  const el = document.getElementById('subcatList');
  if(!el) return;
  el.innerHTML = subs.length ? subs.map(s=>`
    <div class="ledger-row">
      <span class="label">${escapeHtml(s)}</span><span class="fill"></span>
      <button class="icon-btn removeSubcatBtn" data-name="${escapeHtml(s)}" title="Remove" style="width:26px;height:26px;font-size:0.8rem;">×</button>
    </div>`).join('') : `<p class="page-sub mt-0">No subcategories yet.</p>`;
  el.querySelectorAll('.removeSubcatBtn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const list = Store.data.settings.categorySubcategoryMap[cat];
      Store.data.settings.categorySubcategoryMap[cat] = list.filter(x=>x!==btn.dataset.name);
      Store.save(); toast('Removed'); renderSubcatList();
    });
  });
}

function wireMorePage(){
  const signInBtn = document.getElementById('signInBtn');
  if(signInBtn) signInBtn.addEventListener('click', ()=> DriveSync.signIn());
  const signOutBtn = document.getElementById('signOutBtn');
  if(signOutBtn) signOutBtn.addEventListener('click', ()=>{ DriveSync.signOut(); render(); });
  const syncNowBtn = document.getElementById('syncNowBtn');
  if(syncNowBtn) syncNowBtn.addEventListener('click', ()=> DriveSync.syncNow());
  if(!wireMorePage._subscribed){
    wireMorePage._subscribed = true;
    DriveSync.onStatusChange(()=>{ if(currentRoute==='more') render(); });
  }

  uiState.catEditorCat = uiState.catEditorCat || Object.keys(Store.data.settings.categorySubcategoryMap)[0];
  renderSubcatList();
  document.getElementById('catEditorSelect').addEventListener('change', e=>{
    uiState.catEditorCat = e.target.value; renderSubcatList();
  });
  document.getElementById('addSubcatBtn').addEventListener('click', ()=>{
    const input = document.getElementById('newSubcatInput');
    const name = input.value.trim();
    if(!name){ toast('Type a name first'); return; }
    const cat = uiState.catEditorCat;
    if(!Store.data.settings.categorySubcategoryMap[cat].includes(name)){
      Store.data.settings.categorySubcategoryMap[cat].push(name);
      Store.save(); toast('Added');
    }
    input.value='';
    renderSubcatList();
  });
  document.getElementById('addAccountBtn').addEventListener('click', ()=>{
    const name = prompt('Account name:'); if(!name) return;
    const opening = parseFloat(prompt('Opening balance (₹):','0')||'0');
    Store.data.accounts.push({ id: Store.newId('a'), name, openingBalance:isNaN(opening)?0:opening, openingDate: todayStr(), purpose:'', status:'Active' });
    Store.save(); toast('Account added'); render();
  });
  document.getElementById('exportBtn').addEventListener('click', ()=>{
    const blob = new Blob([JSON.stringify(Store.data, null, 2)], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `ledger-backup-${todayStr()}.json`;
    a.click(); URL.revokeObjectURL(url);
    toast('Backup downloaded');
  });
  const importFile = document.getElementById('importFile');
  document.getElementById('importBtn').addEventListener('click', ()=> importFile.click());
  importFile.addEventListener('change', e=>{
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = ()=>{
      try{
        const parsed = JSON.parse(reader.result);
        if(!parsed.accounts || !parsed.transactions){ toast('That file doesn\'t look like a Ledger backup'); return; }
        if(confirm('This will replace all current data with the backup. Continue?')){
          Store.data = parsed;
          Store.save();
          toast('Backup restored');
          navigate('dashboard');
        }
      }catch(err){ toast('Could not read that file'); }
    };
    reader.readAsText(file);
  });
  document.getElementById('resetBtn').addEventListener('click', ()=>{
    if(confirm('This erases everything on this device and reloads the starting data. Continue?')){
      localStorage.removeItem(STORAGE_KEY);
      Store.load();
      toast('Data reset');
      navigate('dashboard');
    }
  });
}

function pickAccount(label){
  const names = Store.data.accounts.map(a=>a.name);
  const val = prompt(`${label}\n(${names.join(', ')})`, names[0]||'');
  if(val===null) return null;
  if(!names.includes(val)){ toast('Account not recognized'); return null; }
  return val;
}

/* ===================== Init ===================== */
document.addEventListener('DOMContentLoaded', ()=>{
  Store.load();
  document.querySelectorAll('.navlink[data-route]').forEach(btn=>{
    btn.addEventListener('click', ()=> navigate(btn.dataset.route));
  });
  navigate('dashboard');
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
});
