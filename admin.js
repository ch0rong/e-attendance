/**
 * 광주시 청년지원센터 - 관리자 페이지 로직 (admin.js)
 */

// ============================================================================
// 설정
// ============================================================================
const APP_CONFIG = window.APP_CONFIG || {};

// true: 브라우저 localStorage를 사용하는 로컬 테스트 모드
// false: Google Apps Script(GAS) + Google Sheets 실연동 모드
const IS_TEST_MODE =
  typeof APP_CONFIG.IS_TEST_MODE === 'boolean' ? APP_CONFIG.IS_TEST_MODE : true;

// GAS 웹 앱 URL (config.js 또는 배포 환경에서 주입)
const GAS_WEB_APP_URL = String(APP_CONFIG.GAS_WEB_APP_URL || '').trim();

// 관리자 기본 비밀번호 상수
const ADMIN_PASSWORD = '1234';

// 인증 통과 후 메모리에만 유지하는 관리자 비밀번호
let adminSessionPassword = '';

const STORAGE_KEY_PROGRAMS = 'gjyouth_programs';
const CODE_PREFIX = 'gjyouth-';
const CODE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 6;

const BIRTH_YEAR_MAX = 2012;
const BIRTH_YEAR_MIN = 1960;
const BIRTH_YEAR_DEFAULT = 2000;
const BIRTH_MONTH_DEFAULT = 1;
const BIRTH_DAY_DEFAULT = 1;
const DEFAULT_BIRTH_ISO = '2000-01-01';

const NAME_BLACKLIST = [
  '홍길동',
  '테스트',
  '관리자',
  '아무개',
  '가나다',
  '이름없음',
  '김철수',
  '이영희',
  '박민수',
  '성명',
  '이름',
];

let cachedPrograms = [];
let editingProgramCode = null;

// ============================================================================
// 유틸리티 함수
// ============================================================================

function getDaysInMonth(year, month) {
  if (!year || !month) return 31;
  return new Date(Number(year), Number(month), 0).getDate();
}

function normalizeGender(raw) {
  const val = String(raw || '').trim();
  if (val === '남' || val === '남성') return '남';
  if (val === '여' || val === '여성') return '여';
  return '';
}

function sortRosterKorean(list) {
  return [...list].sort((a, b) => {
    const nameDiff = a.name.localeCompare(b.name, 'ko-KR');
    if (nameDiff !== 0) return nameDiff;
    return String(a.birthDate || '').localeCompare(String(b.birthDate || ''));
  });
}

/**
 * 출석부 명단 정규화 (배열 / JSON 문자열 / 구형 데이터 호환 + 한글 가나다순 정렬)
 * @returns {Array<{ name: string, birthDate: string, gender: string }>}
 */
function normalizeRosterList(raw) {
  let source = [];

  if (Array.isArray(raw)) {
    source = raw;
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) source = parsed;
      } catch (err) {
        source = [];
      }
    }
  }

  const seen = new Set();
  const result = [];

  source.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const name = String(entry.name || '').replace(/\s+/g, '');
    const birthDate = String(entry.birthDate || '').trim();
    const gender = normalizeGender(entry.gender);
    if (!name) return;

    const key = `${name}|${birthDate}|${gender}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ name, birthDate, gender });
    }
  });

  return sortRosterKorean(result);
}

/**
 * 이름 검증 (공백 제거 후 한글 완성형 2~5자, 3회 연속 반복 금지, 블랙리스트 차단)
 */
function validateKoreanName(rawName) {
  const cleaned = String(rawName || '').replace(/\s+/g, '');
  if (!cleaned) {
    return { valid: false, message: '이름을 입력해주세요.' };
  }
  if (!/^[가-힣]{2,5}$/.test(cleaned)) {
    return {
      valid: false,
      message: '이름은 한글 완성형 2~5글자만 입력할 수 있습니다.',
    };
  }
  if (/(.)\1{2,}/.test(cleaned)) {
    return {
      valid: false,
      message: '동일한 글자를 3회 이상 반복한 이름은 등록할 수 없습니다.',
    };
  }
  if (NAME_BLACKLIST.includes(cleaned)) {
    return {
      valid: false,
      message: `'${cleaned}'은(는) 사용할 수 없는 이름입니다. 올바른 실명을 입력해주세요.`,
    };
  }
  return { valid: true, cleanedName: cleaned };
}

/**
 * 고유 프로그램 코드 생성 (gjyouth- + 6자리 영문 대문자/숫자)
 */
function generateProgramCode(existingCodes = []) {
  const existingSet = new Set(existingCodes);

  for (let attempt = 0; attempt < 30; attempt++) {
    let suffix = '';
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      const randomBytes = new Uint32Array(CODE_LENGTH);
      window.crypto.getRandomValues(randomBytes);
      for (let i = 0; i < CODE_LENGTH; i++) {
        suffix += CODE_CHARSET[randomBytes[i] % CODE_CHARSET.length];
      }
    } else {
      for (let i = 0; i < CODE_LENGTH; i++) {
        suffix += CODE_CHARSET[Math.floor(Math.random() * CODE_CHARSET.length)];
      }
    }

    const code = `${CODE_PREFIX}${suffix}`;
    if (!existingSet.has(code)) {
      return code;
    }
  }

  return `${CODE_PREFIX}${Date.now().toString(36).toUpperCase().slice(-CODE_LENGTH)}`;
}

/**
 * 현재 도메인 기준 참가자 출석 등록 전용 URL 생성
 */
function buildAttendanceUrl(code) {
  const url = new URL('./index.html', window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('code', code);
  return url.toString();
}

function getTodayIsoLocal() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatLocalDateTime(dateObj = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())} ` +
    `${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}:${pad(dateObj.getSeconds())}`
  );
}

/**
 * 클립보드 복사 및 버튼 피드백 처리
 */
async function copyTextWithFeedback(text, buttonEl) {
  let copied = false;

  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (err) {
      copied = false;
    }
  }

  if (!copied) {
    const tempTextarea = document.createElement('textarea');
    tempTextarea.value = text;
    tempTextarea.setAttribute('readonly', '');
    tempTextarea.style.position = 'fixed';
    tempTextarea.style.top = '-9999px';
    tempTextarea.style.left = '-9999px';
    document.body.appendChild(tempTextarea);
    tempTextarea.select();
    try {
      copied = document.execCommand('copy');
    } catch (err) {
      copied = false;
    }
    document.body.removeChild(tempTextarea);
  }

  if (!buttonEl) return copied;

  const originalText = buttonEl.dataset.originalText || buttonEl.textContent.trim();
  buttonEl.dataset.originalText = originalText;

  if (buttonEl._copyTimer) {
    clearTimeout(buttonEl._copyTimer);
  }

  if (copied) {
    buttonEl.textContent = '복사 완료!';
    buttonEl.classList.add('btn--copied');
    buttonEl._copyTimer = setTimeout(() => {
      buttonEl.textContent = originalText;
      buttonEl.classList.remove('btn--copied');
    }, 2000);
  } else {
    alert('자동 복사에 실패했습니다. 링크를 직접 선택해 복사해주세요.');
  }

  return copied;
}

// ============================================================================
// 데이터 레이어 (localStorage 테스트 모드 / GAS 실연동 모드)
// ============================================================================

function getLocalPrograms() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PROGRAMS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((p) => {
      const roster = normalizeRosterList(p.roster || p.preRegisteredList);
      return {
        ...p,
        roster,
        preRegisteredList: roster,
      };
    });
  } catch (err) {
    return [];
  }
}

function saveLocalPrograms(programs) {
  localStorage.setItem(STORAGE_KEY_PROGRAMS, JSON.stringify(programs));
}

async function verifyAdminPassword(password) {
  if (IS_TEST_MODE) {
    if (password === ADMIN_PASSWORD) {
      return { ok: true };
    }
    return { ok: false, message: '비밀번호가 일치하지 않습니다.' };
  }

  if (!GAS_WEB_APP_URL) {
    return {
      ok: false,
      message: 'GAS_WEB_APP_URL이 설정되지 않았습니다. config.js 설정을 확인해주세요.',
    };
  }

  const response = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    redirect: 'follow',
    body: JSON.stringify({
      action: 'verifyAdmin',
      adminPassword: password,
    }),
  });

  if (!response.ok) {
    throw new Error(`서버 응답 오류 (HTTP ${response.status})`);
  }

  const result = await response.json();
  if (result.status === 'success') {
    return { ok: true };
  }

  return {
    ok: false,
    message: result.message || '비밀번호가 일치하지 않습니다.',
  };
}

async function fetchProgramList() {
  if (IS_TEST_MODE) {
    return getLocalPrograms();
  }

  if (!GAS_WEB_APP_URL) {
    throw new Error('GAS_WEB_APP_URL이 설정되지 않았습니다.');
  }

  const response = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    redirect: 'follow',
    body: JSON.stringify({
      action: 'listPrograms',
      adminPassword: adminSessionPassword,
    }),
  });

  if (!response.ok) {
    throw new Error(`서버 응답 오류 (HTTP ${response.status})`);
  }

  const result = await response.json();
  if (result.status !== 'success') {
    throw new Error(result.message || '프로그램 목록을 불러오지 못했습니다.');
  }

  return Array.isArray(result.data)
    ? result.data.map((p) => {
        const roster = normalizeRosterList(p.roster || p.preRegisteredList);
        return {
          ...p,
          roster,
          preRegisteredList: roster,
        };
      })
    : [];
}

async function saveNewProgram(programData) {
  const sortedRoster = normalizeRosterList(programData.roster);

  if (IS_TEST_MODE) {
    const list = getLocalPrograms();
    const record = {
      createdAt: formatLocalDateTime(),
      code: programData.code,
      name: programData.name,
      date: programData.date,
      time: programData.time,
      instructor: programData.instructor,
      roster: sortedRoster,
      preRegisteredList: sortedRoster,
    };
    list.unshift(record);
    saveLocalPrograms(list);
    return record;
  }

  if (!GAS_WEB_APP_URL) {
    throw new Error('GAS_WEB_APP_URL이 설정되지 않았습니다.');
  }

  const response = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    redirect: 'follow',
    body: JSON.stringify({
      action: 'createProgram',
      adminPassword: adminSessionPassword,
      code: programData.code,
      name: programData.name,
      date: programData.date,
      time: programData.time,
      instructor: programData.instructor,
      roster: sortedRoster,
    }),
  });

  if (!response.ok) {
    throw new Error(`서버 응답 오류 (HTTP ${response.status})`);
  }

  const result = await response.json();
  if (result.status !== 'success') {
    throw new Error(result.message || '프로그램 생성에 실패했습니다.');
  }

  const saved = result.data || {};
  const roster = normalizeRosterList(saved.roster || saved.preRegisteredList || sortedRoster);
  return { ...saved, roster, preRegisteredList: roster };
}

async function updateExistingProgram(programData) {
  const sortedRoster = normalizeRosterList(programData.roster);

  if (IS_TEST_MODE) {
    const list = getLocalPrograms();
    const idx = list.findIndex((item) => item.code === programData.code);
    if (idx === -1) {
      throw new Error('수정할 프로그램을 찾을 수 없습니다.');
    }
    const updated = {
      ...list[idx],
      name: programData.name,
      date: programData.date,
      time: programData.time,
      instructor: programData.instructor,
      roster: sortedRoster,
      preRegisteredList: sortedRoster,
    };
    list[idx] = updated;
    saveLocalPrograms(list);
    return updated;
  }

  if (!GAS_WEB_APP_URL) {
    throw new Error('GAS_WEB_APP_URL이 설정되지 않았습니다.');
  }

  const response = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    redirect: 'follow',
    body: JSON.stringify({
      action: 'updateProgram',
      adminPassword: adminSessionPassword,
      code: programData.code,
      name: programData.name,
      date: programData.date,
      time: programData.time,
      instructor: programData.instructor,
      roster: sortedRoster,
    }),
  });

  if (!response.ok) {
    throw new Error(`서버 응답 오류 (HTTP ${response.status})`);
  }

  const result = await response.json();
  if (result.status !== 'success') {
    throw new Error(result.message || '프로그램 수정에 실패했습니다.');
  }

  const saved = result.data || {};
  const roster = normalizeRosterList(saved.roster || saved.preRegisteredList || sortedRoster);
  return { ...saved, roster, preRegisteredList: roster };
}

async function deleteProgramByCode(code) {
  if (IS_TEST_MODE) {
    const list = getLocalPrograms();
    const filtered = list.filter((item) => item.code !== code);
    if (filtered.length === list.length) {
      throw new Error('삭제할 프로그램을 찾을 수 없습니다.');
    }
    saveLocalPrograms(filtered);
    return { code };
  }

  if (!GAS_WEB_APP_URL) {
    throw new Error('GAS_WEB_APP_URL이 설정되지 않았습니다.');
  }

  const response = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    redirect: 'follow',
    body: JSON.stringify({
      action: 'deleteProgram',
      adminPassword: adminSessionPassword,
      code,
    }),
  });

  if (!response.ok) {
    throw new Error(`서버 응답 오류 (HTTP ${response.status})`);
  }

  const result = await response.json();
  if (result.status !== 'success') {
    throw new Error(result.message || '프로그램 삭제에 실패했습니다.');
  }

  return result.data;
}

// ============================================================================
// UI 초기화 및 이벤트 바인딩
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  // 테스트 모드 배지
  const authTestModeBadge = document.getElementById('authTestModeBadge');
  const testModeBadge = document.getElementById('testModeBadge');
  if (IS_TEST_MODE) {
    if (authTestModeBadge) authTestModeBadge.classList.remove('hidden');
    if (testModeBadge) testModeBadge.classList.remove('hidden');
  }

  // 인증 요소
  const authSection = document.getElementById('authSection');
  const authForm = document.getElementById('authForm');
  const adminPasswordInput = document.getElementById('adminPasswordInput');
  const authError = document.getElementById('authError');
  const authSubmitBtn = document.getElementById('authSubmitBtn');
  const adminDashboard = document.getElementById('adminDashboard');

  // 폼 카드 / 수정 모드 요소
  const programFormCard = document.getElementById('programFormCard');
  const editModeBanner = document.getElementById('editModeBanner');
  const editModeCodeLabel = document.getElementById('editModeCodeLabel');
  const cancelEditBtn = document.getElementById('cancelEditBtn');
  const cancelEditBottomBtn = document.getElementById('cancelEditBottomBtn');
  const programFormTitle = document.getElementById('programFormTitle');
  const programFormSubtitle = document.getElementById('programFormSubtitle');

  // 기본 입력 요소
  const createProgramForm = document.getElementById('createProgramForm');
  const inputProgramName = document.getElementById('inputProgramName');
  const inputProgramDate = document.getElementById('inputProgramDate');
  const inputProgramTime = document.getElementById('inputProgramTime');
  const inputInstructor = document.getElementById('inputInstructor');
  const createAlert = document.getElementById('createAlert');
  const createProgramBtn = document.getElementById('createProgramBtn');

  // 출석부 명단 행 리스트 요소
  const rosterCountPill = document.getElementById('rosterCountPill');
  const rosterRowsContainer = document.getElementById('rosterRowsContainer');
  const addRosterRowBtn = document.getElementById('addRosterRowBtn');

  // 생성 결과 카드 요소
  const createdResultSection = document.getElementById('createdResultSection');
  const resultTitleText = document.getElementById('resultTitleText');
  const resultCodeBadge = document.getElementById('resultCodeBadge');
  const resultProgramName = document.getElementById('resultProgramName');
  const resultDateTime = document.getElementById('resultDateTime');
  const resultInstructor = document.getElementById('resultInstructor');
  const resultRosterCount = document.getElementById('resultRosterCount');
  const resultUrlInput = document.getElementById('resultUrlInput');
  const copyResultUrlBtn = document.getElementById('copyResultUrlBtn');
  const openResultUrlLink = document.getElementById('openResultUrlLink');

  // 프로그램 목록 요소
  const refreshListBtn = document.getElementById('refreshListBtn');
  const programListLoading = document.getElementById('programListLoading');
  const programListError = document.getElementById('programListError');
  const programListContainer = document.getElementById('programListContainer');

  // 기본 일자: 오늘 날짜
  inputProgramDate.value = getTodayIsoLocal();

  // --------------------------------------------------------------------------
  // 1. 알림 헬퍼
  // --------------------------------------------------------------------------
  function showCreateAlert(message) {
    createAlert.textContent = message;
    createAlert.classList.remove('hidden');
  }

  function hideCreateAlert() {
    createAlert.textContent = '';
    createAlert.classList.add('hidden');
  }

  // --------------------------------------------------------------------------
  // 2. 출석부 1줄 가로 그리드 행 생성 / 삭제 / 갱신
  // --------------------------------------------------------------------------
  function populateDaySelect(daySelect, year, month, preferredDay) {
    const maxDays = getDaysInMonth(year, month);
    const targetDay = Math.min(Number(preferredDay) || 1, maxDays);
    daySelect.innerHTML = '';
    for (let d = 1; d <= maxDays; d++) {
      const opt = document.createElement('option');
      opt.value = String(d).padStart(2, '0');
      opt.textContent = `${d}일`;
      if (d === targetDay) opt.selected = true;
      daySelect.appendChild(opt);
    }
  }

  function updateRosterSummaryUI() {
    const rows = Array.from(rosterRowsContainer.querySelectorAll('.roster-row'));

    // 첫 번째 행(index === 0)의 삭제 버튼은 숨기고, 2번째 행부터 우측 끝에 표시
    rows.forEach((row, index) => {
      const delBtn = row.querySelector('.roster-row-delete');
      if (!delBtn) return;
      if (index === 0) {
        delBtn.classList.add('is-hidden');
        delBtn.setAttribute('aria-hidden', 'true');
        delBtn.tabIndex = -1;
      } else {
        delBtn.classList.remove('is-hidden');
        delBtn.removeAttribute('aria-hidden');
        delBtn.tabIndex = 0;
      }
    });

    // 이름 입력된 행 수 계산
    let filledCount = 0;
    rows.forEach((row) => {
      const nameVal = row.querySelector('.roster-name-input').value.replace(/\s+/g, '');
      if (nameVal.length > 0) filledCount++;
    });

    if (filledCount > 0) {
      rosterCountPill.textContent = `출석부 ${filledCount}명 입력`;
      rosterCountPill.classList.add('has-names');
    } else {
      rosterCountPill.textContent = '현장 등록 모드';
      rosterCountPill.classList.remove('has-names');
    }
  }

  function createRosterRow(initialData = null) {
    const row = document.createElement('div');
    row.className = 'roster-row';
    row.dataset.gender = '';
    row.dataset.birthTouched = 'false';

    // ① 이름 입력칸
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'form-input roster-name-input';
    nameInput.placeholder = '이름';
    nameInput.maxLength = 10;
    nameInput.setAttribute('aria-label', '참가자 이름');
    if (initialData && initialData.name) {
      nameInput.value = initialData.name;
    }

    // ② 생년월일 3개 셀렉트 ([연도][월][일], 여백 없이 촘촘히 배치, 기본값 2000-01-01)
    const birthGroup = document.createElement('div');
    birthGroup.className = 'birth-select-group';

    let initYear = BIRTH_YEAR_DEFAULT;
    let initMonth = BIRTH_MONTH_DEFAULT;
    let initDay = BIRTH_DAY_DEFAULT;

    if (initialData && initialData.birthDate) {
      const m = String(initialData.birthDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) {
        initYear = Number(m[1]);
        initMonth = Number(m[2]);
        initDay = Number(m[3]);
        row.dataset.birthTouched = 'true';
      }
    }

    const yearSelect = document.createElement('select');
    yearSelect.className = 'form-select roster-birth-year';
    yearSelect.setAttribute('aria-label', '출생 연도');
    for (let y = BIRTH_YEAR_MAX; y >= BIRTH_YEAR_MIN; y--) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = `${y}년`;
      if (y === initYear) opt.selected = true;
      yearSelect.appendChild(opt);
    }

    const monthSelect = document.createElement('select');
    monthSelect.className = 'form-select roster-birth-month';
    monthSelect.setAttribute('aria-label', '출생 월');
    for (let m = 1; m <= 12; m++) {
      const opt = document.createElement('option');
      opt.value = String(m).padStart(2, '0');
      opt.textContent = `${m}월`;
      if (m === initMonth) opt.selected = true;
      monthSelect.appendChild(opt);
    }

    const daySelect = document.createElement('select');
    daySelect.className = 'form-select roster-birth-day';
    daySelect.setAttribute('aria-label', '출생 일');
    populateDaySelect(daySelect, initYear, initMonth, initDay);

    const handleBirthChange = () => {
      row.dataset.birthTouched = 'true';
      populateDaySelect(daySelect, Number(yearSelect.value), Number(monthSelect.value), Number(daySelect.value));
      hideCreateAlert();
    };

    yearSelect.addEventListener('change', handleBirthChange);
    monthSelect.addEventListener('change', handleBirthChange);
    daySelect.addEventListener('change', () => {
      row.dataset.birthTouched = 'true';
      hideCreateAlert();
    });

    birthGroup.appendChild(yearSelect);
    birthGroup.appendChild(monthSelect);
    birthGroup.appendChild(daySelect);

    // ③ 성별 토글 버튼 ([남] [여] 미니 세그먼트 버튼)
    const genderSegment = document.createElement('div');
    genderSegment.className = 'gender-segment';
    genderSegment.setAttribute('role', 'radiogroup');
    genderSegment.setAttribute('aria-label', '성별 선택');

    const initGender = initialData ? normalizeGender(initialData.gender) : '';
    row.dataset.gender = initGender;

    ['남', '여'].forEach((label) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gender-segment-btn';
      btn.dataset.gender = label;
      btn.textContent = label;
      btn.setAttribute('role', 'radio');
      const isSelected = initGender === label;
      btn.setAttribute('aria-checked', String(isSelected));
      if (isSelected) btn.classList.add('is-active');

      btn.addEventListener('click', () => {
        const current = row.dataset.gender;
        const next = current === label ? '' : label;
        row.dataset.gender = next;
        genderSegment.classList.remove('is-invalid');
        genderSegment.querySelectorAll('.gender-segment-btn').forEach((b) => {
          const active = b.dataset.gender === next;
          b.classList.toggle('is-active', active);
          b.setAttribute('aria-checked', String(active));
        });
        hideCreateAlert();
      });

      genderSegment.appendChild(btn);
    });

    // ④ 행 삭제 버튼 (×)
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'roster-row-delete';
    deleteBtn.setAttribute('aria-label', '참가자 행 삭제');
    deleteBtn.title = '행 삭제';
    deleteBtn.textContent = '×';
    deleteBtn.addEventListener('click', () => {
      row.remove();
      if (rosterRowsContainer.querySelectorAll('.roster-row').length === 0) {
        rosterRowsContainer.appendChild(createRosterRow());
      }
      updateRosterSummaryUI();
      hideCreateAlert();
    });

    nameInput.addEventListener('input', () => {
      nameInput.classList.remove('is-invalid');
      updateRosterSummaryUI();
      hideCreateAlert();
    });

    row.appendChild(nameInput);
    row.appendChild(birthGroup);
    row.appendChild(genderSegment);
    row.appendChild(deleteBtn);

    return row;
  }

  function resetRosterRows(entries = []) {
    rosterRowsContainer.innerHTML = '';
    if (Array.isArray(entries) && entries.length > 0) {
      entries.forEach((entry) => {
        rosterRowsContainer.appendChild(createRosterRow(entry));
      });
    } else {
      rosterRowsContainer.appendChild(createRosterRow());
    }
    updateRosterSummaryUI();
  }

  addRosterRowBtn.addEventListener('click', () => {
    const newRow = createRosterRow();
    rosterRowsContainer.appendChild(newRow);
    updateRosterSummaryUI();
    const input = newRow.querySelector('.roster-name-input');
    if (input) input.focus();
  });

  /**
   * 출석부 입력 행 전체 검증 및 한글 가나다순 자동 정렬
   */
  function collectAndValidateRosterRows() {
    const rows = Array.from(rosterRowsContainer.querySelectorAll('.roster-row'));
    const validEntries = [];
    const seenPersonKeys = new Set();

    // 기존 invalid 스타일 초기화
    rows.forEach((row) => {
      row.querySelector('.roster-name-input').classList.remove('is-invalid');
      row.querySelector('.gender-segment').classList.remove('is-invalid');
    });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 1;
      const nameInput = row.querySelector('.roster-name-input');
      const yearSelect = row.querySelector('.roster-birth-year');
      const monthSelect = row.querySelector('.roster-birth-month');
      const daySelect = row.querySelector('.roster-birth-day');
      const genderSegment = row.querySelector('.gender-segment');

      const rawName = nameInput.value;
      const cleanedName = rawName.replace(/\s+/g, '');
      const birthDate = `${yearSelect.value}-${monthSelect.value}-${daySelect.value}`;
      const gender = row.dataset.gender || '';
      const birthChanged = row.dataset.birthTouched === 'true' && birthDate !== DEFAULT_BIRTH_ISO;

      // 완전히 비어있는 행은 무시
      if (!cleanedName && !gender && !birthChanged) {
        continue;
      }

      // 일부만 입력된 행 (이름이 비었는데 성별이나 생년월일을 건드린 경우) 경고
      if (!cleanedName) {
        nameInput.classList.add('is-invalid');
        nameInput.focus();
        return {
          valid: false,
          message: `출석부 ${rowNum}번째 행의 이름을 입력해주세요. (사용하지 않는 행은 삭제해주세요)`,
        };
      }

      // 이름 유효성 검증 (한글 완성형 2~5자, 3회 연속 반복 금지, 블랙리스트 차단)
      const nameCheck = validateKoreanName(cleanedName);
      if (!nameCheck.valid) {
        nameInput.classList.add('is-invalid');
        nameInput.focus();
        return {
          valid: false,
          message: `출석부 ${rowNum}번째 행: ${nameCheck.message}`,
        };
      }

      // 성별 미선택 경고
      if (gender !== '남' && gender !== '여') {
        genderSegment.classList.add('is-invalid');
        const firstGenderBtn = genderSegment.querySelector('.gender-segment-btn');
        if (firstGenderBtn) firstGenderBtn.focus();
        return {
          valid: false,
          message: `출석부 ${rowNum}번째 행(${nameCheck.cleanedName})의 성별을 선택해주세요.`,
        };
      }

      // 중복 입력 차단 (이름 + 생년월일 기준)
      const personKey = `${nameCheck.cleanedName}|${birthDate}`;
      if (seenPersonKeys.has(personKey)) {
        nameInput.classList.add('is-invalid');
        nameInput.focus();
        return {
          valid: false,
          message: `출석부 ${rowNum}번째 행(${nameCheck.cleanedName}, ${birthDate})이 중복 입력되었습니다.`,
        };
      }

      seenPersonKeys.add(personKey);
      validEntries.push({
        name: nameCheck.cleanedName,
        birthDate,
        gender,
      });
    }

    // 이름 기준 한글 가나다순 오름차순 자동 정렬
    const sorted = sortRosterKorean(validEntries);
    return { valid: true, roster: sorted };
  }

  // 초기 빈 행 1개 생성
  resetRosterRows();

  // --------------------------------------------------------------------------
  // 3. 수정 모드 전환 / 초기화
  // --------------------------------------------------------------------------
  function resetFormToCreateMode() {
    editingProgramCode = null;
    editModeBanner.classList.add('hidden');
    cancelEditBottomBtn.classList.add('hidden');
    programFormTitle.textContent = '새 프로그램 생성';
    programFormSubtitle.textContent =
      '프로그램 정보와 출석부 명단을 입력해 참가자 출석 등록용 전용 링크를 발급합니다.';
    createProgramBtn.textContent = '프로그램 생성 및 저장';

    createProgramForm.reset();
    inputProgramDate.value = getTodayIsoLocal();
    resetRosterRows();
    hideCreateAlert();
  }

  function enterEditMode(program) {
    editingProgramCode = program.code;
    editModeCodeLabel.textContent = program.code;
    editModeBanner.classList.remove('hidden');
    cancelEditBottomBtn.classList.remove('hidden');
    programFormTitle.textContent = '프로그램 정보 수정';
    programFormSubtitle.textContent =
      '수정 내용을 저장하면 새 출석 등록부터 반영되며, 기존 출석 기록은 유지됩니다.';
    createProgramBtn.textContent = '변경사항 저장';

    inputProgramName.value = program.name || '';
    inputProgramDate.value = program.date || getTodayIsoLocal();
    inputProgramTime.value = program.time || '';
    inputInstructor.value = program.instructor || '';
    resetRosterRows(normalizeRosterList(program.roster || program.preRegisteredList));
    hideCreateAlert();

    programFormCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    inputProgramName.focus();
  }

  cancelEditBtn.addEventListener('click', resetFormToCreateMode);
  cancelEditBottomBtn.addEventListener('click', resetFormToCreateMode);

  // --------------------------------------------------------------------------
  // 4. 관리자 비밀번호 인증
  // --------------------------------------------------------------------------
  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const entered = adminPasswordInput.value.trim();

    authError.textContent = '';
    authError.classList.remove('visible');
    adminPasswordInput.classList.remove('is-invalid');

    if (!entered) {
      authError.textContent = '관리자 비밀번호를 입력해주세요.';
      authError.classList.add('visible');
      adminPasswordInput.classList.add('is-invalid');
      adminPasswordInput.focus();
      return;
    }

    authSubmitBtn.disabled = true;
    authSubmitBtn.textContent = '확인 중...';

    try {
      const result = await verifyAdminPassword(entered);
      if (result.ok) {
        adminSessionPassword = entered;
        adminPasswordInput.value = '';
        authSection.classList.add('hidden');
        adminDashboard.classList.remove('hidden');
        loadProgramList();
      } else {
        authError.textContent = result.message || '비밀번호가 일치하지 않습니다.';
        authError.classList.add('visible');
        adminPasswordInput.classList.add('is-invalid');
        adminPasswordInput.value = '';
        adminPasswordInput.focus();
      }
    } catch (err) {
      authError.textContent = err.message || '인증 확인 중 오류가 발생했습니다.';
      authError.classList.add('visible');
    } finally {
      authSubmitBtn.disabled = false;
      authSubmitBtn.textContent = '확인';
    }
  });

  adminPasswordInput.addEventListener('input', () => {
    authError.textContent = '';
    authError.classList.remove('visible');
    adminPasswordInput.classList.remove('is-invalid');
  });

  // --------------------------------------------------------------------------
  // 5. 생성 / 수정 결과 카드 표시
  // --------------------------------------------------------------------------
  function showResultCard(program, isEdit = false) {
    const attendanceUrl = buildAttendanceUrl(program.code);
    const roster = normalizeRosterList(program.roster || program.preRegisteredList);

    resultTitleText.textContent = isEdit
      ? '프로그램 정보가 수정되었습니다'
      : '프로그램이 생성되었습니다';
    resultCodeBadge.textContent = program.code;
    resultProgramName.textContent = program.name;
    resultDateTime.textContent = `${program.date} · ${program.time}`;
    resultInstructor.textContent = program.instructor;
    resultRosterCount.textContent =
      roster.length > 0
        ? `출석부 ${roster.length}명 (가나다순 정렬 완료)`
        : '현장 등록 모드 (0명 / 인원 제한 없음)';

    resultUrlInput.value = attendanceUrl;
    openResultUrlLink.href = attendanceUrl;

    createdResultSection.classList.remove('hidden');
    createdResultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  copyResultUrlBtn.addEventListener('click', () => {
    if (!resultUrlInput.value) return;
    copyTextWithFeedback(resultUrlInput.value, copyResultUrlBtn);
  });

  // --------------------------------------------------------------------------
  // 6. 프로그램 생성 및 저장 제출
  // --------------------------------------------------------------------------
  createProgramForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideCreateAlert();

    const name = inputProgramName.value.trim();
    const date = inputProgramDate.value.trim();
    const time = inputProgramTime.value.trim();
    const instructor = inputInstructor.value.trim();

    if (!name) {
      showCreateAlert('프로그램명을 입력해주세요.');
      inputProgramName.focus();
      return;
    }
    if (!date) {
      showCreateAlert('프로그램 일자를 선택해주세요.');
      inputProgramDate.focus();
      return;
    }
    if (!time) {
      showCreateAlert('프로그램 시간을 입력해주세요. (예: 14:00 ~ 16:00)');
      inputProgramTime.focus();
      return;
    }
    if (!instructor) {
      showCreateAlert('강사명을 입력해주세요.');
      inputInstructor.focus();
      return;
    }

    const rosterValidation = collectAndValidateRosterRows();
    if (!rosterValidation.valid) {
      showCreateAlert(rosterValidation.message);
      return;
    }

    const isEditing = Boolean(editingProgramCode);
    const targetCode = isEditing
      ? editingProgramCode
      : generateProgramCode(cachedPrograms.map((p) => p.code));

    createProgramBtn.disabled = true;
    createProgramBtn.textContent = isEditing ? '수정 저장 중...' : '프로그램 저장 중...';

    try {
      const savedProgram = isEditing
        ? await updateExistingProgram({
            code: targetCode,
            name,
            date,
            time,
            instructor,
            roster: rosterValidation.roster,
          })
        : await saveNewProgram({
            code: targetCode,
            name,
            date,
            time,
            instructor,
            roster: rosterValidation.roster,
          });

      showResultCard(savedProgram, isEditing);
      resetFormToCreateMode();
      await loadProgramList();
    } catch (err) {
      showCreateAlert(err.message || '프로그램 저장 중 오류가 발생했습니다.');
    } finally {
      createProgramBtn.disabled = false;
      createProgramBtn.textContent = editingProgramCode
        ? '변경사항 저장'
        : '프로그램 생성 및 저장';
    }
  });

  // --------------------------------------------------------------------------
  // 7. 기존 생성된 프로그램 목록 조회 및 렌더링
  // --------------------------------------------------------------------------
  function renderProgramList(programs) {
    programListContainer.innerHTML = '';

    if (!programs || programs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '아직 생성된 프로그램이 없습니다. 위 양식에서 첫 프로그램을 생성해보세요.';
      programListContainer.appendChild(empty);
      return;
    }

    programs.forEach((program) => {
      const attendanceUrl = buildAttendanceUrl(program.code);
      const roster = normalizeRosterList(program.roster || program.preRegisteredList);

      const item = document.createElement('article');
      item.className = 'program-item';

      // 상단: 프로그램명 + 배지
      const top = document.createElement('div');
      top.className = 'program-item-top';

      const nameEl = document.createElement('h3');
      nameEl.className = 'program-item-name';
      nameEl.textContent = program.name;

      const badges = document.createElement('div');
      badges.className = 'program-item-badges';

      const codeBadge = document.createElement('span');
      codeBadge.className = 'badge badge--code';
      codeBadge.textContent = program.code;

      const modeBadge = document.createElement('span');
      if (roster.length > 0) {
        modeBadge.className = 'badge badge--primary';
        modeBadge.textContent = `출석부 ${roster.length}명`;
      } else {
        modeBadge.className = 'badge badge--open';
        modeBadge.textContent = '현장 등록';
      }

      badges.appendChild(codeBadge);
      badges.appendChild(modeBadge);
      top.appendChild(nameEl);
      top.appendChild(badges);

      // 메타: 일시, 강사명, 생성일시
      const meta = document.createElement('div');
      meta.className = 'program-item-meta';

      const dateSpan = document.createElement('span');
      dateSpan.textContent = `일시: ${program.date} ${program.time}`;

      const instructorSpan = document.createElement('span');
      instructorSpan.textContent = `강사: ${program.instructor}`;

      meta.appendChild(dateSpan);
      meta.appendChild(instructorSpan);

      if (program.createdAt) {
        const createdSpan = document.createElement('span');
        createdSpan.textContent = `생성: ${program.createdAt}`;
        meta.appendChild(createdSpan);
      }

      // 링크 + 버튼
      const linkRow = document.createElement('div');
      linkRow.className = 'program-item-link-row';

      const linkAnchor = document.createElement('a');
      linkAnchor.className = 'program-item-url';
      linkAnchor.href = attendanceUrl;
      linkAnchor.target = '_blank';
      linkAnchor.rel = 'noopener noreferrer';
      linkAnchor.textContent = attendanceUrl;

      const actions = document.createElement('div');
      actions.className = 'program-item-actions';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn btn--secondary btn--sm';
      copyBtn.textContent = '링크 복사';
      copyBtn.addEventListener('click', () => {
        copyTextWithFeedback(attendanceUrl, copyBtn);
      });

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn--secondary btn--sm';
      editBtn.textContent = '수정';
      editBtn.addEventListener('click', () => {
        enterEditMode(program);
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn--danger-outline btn--sm';
      deleteBtn.textContent = '삭제';
      deleteBtn.addEventListener('click', async () => {
        const ok = window.confirm(
          `[${program.name}] (${program.code}) 프로그램을 삭제하시겠습니까?\n기존 출석 완료 기록은 유지됩니다.`
        );
        if (!ok) return;

        deleteBtn.disabled = true;
        deleteBtn.textContent = '삭제 중...';
        try {
          await deleteProgramByCode(program.code);
          if (editingProgramCode === program.code) {
            resetFormToCreateMode();
          }
          if (resultCodeBadge.textContent === program.code) {
            createdResultSection.classList.add('hidden');
          }
          await loadProgramList();
        } catch (err) {
          alert(err.message || '프로그램 삭제 중 오류가 발생했습니다.');
          deleteBtn.disabled = false;
          deleteBtn.textContent = '삭제';
        }
      });

      actions.appendChild(copyBtn);
      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);

      linkRow.appendChild(linkAnchor);
      linkRow.appendChild(actions);

      item.appendChild(top);
      item.appendChild(meta);
      item.appendChild(linkRow);
      programListContainer.appendChild(item);
    });
  }

  async function loadProgramList() {
    programListError.classList.add('hidden');
    programListLoading.classList.remove('hidden');
    programListContainer.innerHTML = '';

    try {
      const programs = await fetchProgramList();
      cachedPrograms = programs;
      renderProgramList(programs);
    } catch (err) {
      programListError.textContent = err.message || '프로그램 목록을 불러오지 못했습니다.';
      programListError.classList.remove('hidden');
    } finally {
      programListLoading.classList.add('hidden');
    }
  }

  refreshListBtn.addEventListener('click', loadProgramList);
});
