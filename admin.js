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

const ERROR_MSG_INVALID_BIRTH6 = '올바른 생년월일 6자리(예: 960211)를 입력해주세요.';

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

function parseBoolFlag(val) {
  if (typeof val === 'boolean') return val;
  const s = String(val || '').trim().toUpperCase();
  return s === 'Y' || s === 'TRUE' || s === '1' || s === 'YES';
}

function normalizeGender(raw) {
  const val = String(raw || '').trim();
  if (val === '남' || val === '남성') return '남';
  if (val === '여' || val === '여성') return '여';
  return '';
}

/**
 * 생년월일 6자리(YYMMDD) 검증 및 YYYY-MM-DD 변환
 * - 60 ~ 99 => 1960 ~ 1999년
 * - 00 ~ 12 => 2000 ~ 2012년
 * - 그 외 연도(13 ~ 59) 또는 존재하지 않는 월/일 차단
 */
function parseBirthDate6(rawValue) {
  const digits = String(rawValue || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(digits)) {
    return { valid: false, message: ERROR_MSG_INVALID_BIRTH6 };
  }

  const yy = parseInt(digits.slice(0, 2), 10);
  const mm = parseInt(digits.slice(2, 4), 10);
  const dd = parseInt(digits.slice(4, 6), 10);

  let fullYear = null;
  if (yy >= 60 && yy <= 99) {
    fullYear = 1900 + yy;
  } else if (yy >= 0 && yy <= 12) {
    fullYear = 2000 + yy;
  } else {
    return { valid: false, message: ERROR_MSG_INVALID_BIRTH6 };
  }

  if (mm < 1 || mm > 12) {
    return { valid: false, message: ERROR_MSG_INVALID_BIRTH6 };
  }

  const maxDays = new Date(fullYear, mm, 0).getDate();
  if (dd < 1 || dd > maxDays) {
    return { valid: false, message: ERROR_MSG_INVALID_BIRTH6 };
  }

  const iso = `${fullYear}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  return { valid: true, iso, digits, fullYear };
}

/**
 * YYYY-MM-DD -> YYMMDD 6자리 변환 (수정 모드 입력칸 표시용)
 */
function formatIsoToBirth6(rawValue) {
  const str = String(rawValue || '').trim();
  const m = str.match(/^\d{2}(\d{2})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  return str.replace(/\D/g, '').slice(0, 6);
}

function normalizeBirthDateToIso(rawValue) {
  const str = String(rawValue || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const parsed = parseBirthDate6(str);
  return parsed.valid ? parsed.iso : str;
}

function sortRosterKorean(list) {
  return [...list].sort((a, b) => {
    const nameDiff = a.name.localeCompare(b.name, 'ko-KR');
    if (nameDiff !== 0) return nameDiff;
    return String(a.birthDate || '').localeCompare(String(b.birthDate || ''));
  });
}

/**
 * 출석부 명단 정규화 + 한글 가나다순 오름차순 자동 정렬
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
    const birthDate = normalizeBirthDateToIso(entry.birthDate || '');
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

function normalizeProgramObject(p) {
  const roster = normalizeRosterList(p.roster || p.preRegisteredList);
  const locationEnabled = parseBoolFlag(p.locationEnabled);
  return {
    ...p,
    roster,
    preRegisteredList: roster,
    isMultiSession: parseBoolFlag(p.isMultiSession),
    locationEnabled,
    locationName: String(p.locationName || '').trim(),
    latitude: p.latitude !== undefined && p.latitude !== '' ? String(p.latitude).trim() : '',
    longitude: p.longitude !== undefined && p.longitude !== '' ? String(p.longitude).trim() : '',
    allowedRadius: Number(p.allowedRadius) || 300,
    managerCode: String(p.managerCode || '').trim(),
  };
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
 * 4자리 숫자 담당자 확인 코드 랜덤 생성
 */
function generateManagerCode() {
  if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
    const arr = new Uint32Array(1);
    window.crypto.getRandomValues(arr);
    return String(1000 + (arr[0] % 9000));
  }
  return String(Math.floor(1000 + Math.random() * 9000));
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
    return parsed.map(normalizeProgramObject);
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

  return Array.isArray(result.data) ? result.data.map(normalizeProgramObject) : [];
}

async function saveNewProgram(programData) {
  const sortedRoster = normalizeRosterList(programData.roster);
  const payloadFields = {
    code: programData.code,
    name: programData.name,
    date: programData.date,
    time: programData.time,
    instructor: programData.instructor,
    roster: sortedRoster,
    isMultiSession: Boolean(programData.isMultiSession),
    locationEnabled: Boolean(programData.locationEnabled),
    locationName: programData.locationEnabled ? String(programData.locationName || '').trim() : '',
    latitude: programData.locationEnabled ? String(programData.latitude || '').trim() : '',
    longitude: programData.locationEnabled ? String(programData.longitude || '').trim() : '',
    allowedRadius: programData.locationEnabled ? Number(programData.allowedRadius) || 300 : '',
    managerCode: String(programData.managerCode || '').trim(),
  };

  if (IS_TEST_MODE) {
    const list = getLocalPrograms();
    const record = normalizeProgramObject({
      createdAt: formatLocalDateTime(),
      ...payloadFields,
    });
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
      ...payloadFields,
    }),
  });

  if (!response.ok) {
    throw new Error(`서버 응답 오류 (HTTP ${response.status})`);
  }

  const result = await response.json();
  if (result.status !== 'success') {
    throw new Error(result.message || '프로그램 생성에 실패했습니다.');
  }

  return normalizeProgramObject(result.data || payloadFields);
}

async function updateExistingProgram(programData) {
  const sortedRoster = normalizeRosterList(programData.roster);
  const payloadFields = {
    code: programData.code,
    name: programData.name,
    date: programData.date,
    time: programData.time,
    instructor: programData.instructor,
    roster: sortedRoster,
    isMultiSession: Boolean(programData.isMultiSession),
    locationEnabled: Boolean(programData.locationEnabled),
    locationName: programData.locationEnabled ? String(programData.locationName || '').trim() : '',
    latitude: programData.locationEnabled ? String(programData.latitude || '').trim() : '',
    longitude: programData.locationEnabled ? String(programData.longitude || '').trim() : '',
    allowedRadius: programData.locationEnabled ? Number(programData.allowedRadius) || 300 : '',
    managerCode: String(programData.managerCode || '').trim(),
  };

  if (IS_TEST_MODE) {
    const list = getLocalPrograms();
    const idx = list.findIndex((item) => item.code === programData.code);
    if (idx === -1) {
      throw new Error('수정할 프로그램을 찾을 수 없습니다.');
    }
    const updated = normalizeProgramObject({
      ...list[idx],
      ...payloadFields,
    });
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
      ...payloadFields,
    }),
  });

  if (!response.ok) {
    throw new Error(`서버 응답 오류 (HTTP ${response.status})`);
  }

  const result = await response.json();
  if (result.status !== 'success') {
    throw new Error(result.message || '프로그램 수정에 실패했습니다.');
  }

  return normalizeProgramObject(result.data || payloadFields);
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
  const inputIsMultiSession = document.getElementById('inputIsMultiSession');
  const inputProgramTime = document.getElementById('inputProgramTime');
  const inputInstructor = document.getElementById('inputInstructor');
  const createAlert = document.getElementById('createAlert');
  const createProgramBtn = document.getElementById('createProgramBtn');

  // 위치 기반 제한 설정 요소
  const inputLocationEnabled = document.getElementById('inputLocationEnabled');
  const locationFieldsWrap = document.getElementById('locationFieldsWrap');
  const inputLocationName = document.getElementById('inputLocationName');
  const inputLatitude = document.getElementById('inputLatitude');
  const inputLongitude = document.getElementById('inputLongitude');
  const fetchMyLocationBtn = document.getElementById('fetchMyLocationBtn');
  const locationFetchStatus = document.getElementById('locationFetchStatus');
  const inputAllowedRadius = document.getElementById('inputAllowedRadius');
  const inputManagerCode = document.getElementById('inputManagerCode');
  const regenManagerCodeBtn = document.getElementById('regenManagerCodeBtn');

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
  const resultLocationRow = document.getElementById('resultLocationRow');
  const resultLocationText = document.getElementById('resultLocationText');
  const resultManagerCodeRow = document.getElementById('resultManagerCodeRow');
  const resultManagerCodeText = document.getElementById('resultManagerCodeText');
  const resultUrlInput = document.getElementById('resultUrlInput');
  const copyResultUrlBtn = document.getElementById('copyResultUrlBtn');
  const openResultUrlLink = document.getElementById('openResultUrlLink');

  // 프로그램 목록 요소
  const refreshListBtn = document.getElementById('refreshListBtn');
  const programListLoading = document.getElementById('programListLoading');
  const programListError = document.getElementById('programListError');
  const programListContainer = document.getElementById('programListContainer');

  // 기본 일자: 오늘 날짜 & 기본 담당자 확인 코드 자동 생성
  inputProgramDate.value = getTodayIsoLocal();
  inputManagerCode.value = generateManagerCode();

  // --------------------------------------------------------------------------
  // 1. 알림 및 위치 설정 UI 헬퍼
  // --------------------------------------------------------------------------
  function showCreateAlert(message) {
    createAlert.textContent = message;
    createAlert.classList.remove('hidden');
  }

  function hideCreateAlert() {
    createAlert.textContent = '';
    createAlert.classList.add('hidden');
  }

  function setLocationStatus(message, type = '') {
    locationFetchStatus.textContent = message;
    locationFetchStatus.classList.remove('is-success', 'is-error');
    if (type === 'success') locationFetchStatus.classList.add('is-success');
    if (type === 'error') locationFetchStatus.classList.add('is-error');
  }

  function syncLocationFieldsVisibility() {
    if (inputLocationEnabled.checked) {
      locationFieldsWrap.classList.remove('hidden');
    } else {
      locationFieldsWrap.classList.add('hidden');
      setLocationStatus('');
    }
  }

  inputLocationEnabled.addEventListener('change', () => {
    syncLocationFieldsVisibility();
    hideCreateAlert();
  });

  regenManagerCodeBtn.addEventListener('click', () => {
    inputManagerCode.value = generateManagerCode();
    hideCreateAlert();
  });

  fetchMyLocationBtn.addEventListener('click', () => {
    hideCreateAlert();
    if (!navigator.geolocation) {
      setLocationStatus('이 브라우저에서는 위치 정보 조회(GPS)를 지원하지 않습니다.', 'error');
      return;
    }

    fetchMyLocationBtn.disabled = true;
    fetchMyLocationBtn.textContent = '위치 불러오는 중...';
    setLocationStatus('현재 위치 좌표를 확인하는 중입니다...');

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Number(pos.coords.latitude).toFixed(6);
        const lng = Number(pos.coords.longitude).toFixed(6);
        inputLatitude.value = lat;
        inputLongitude.value = lng;
        const acc = Math.round(pos.coords.accuracy || 0);
        setLocationStatus(
          `현재 좌표가 입력되었습니다. (위도 ${lat}, 경도 ${lng}${acc ? ` · 오차 약 ${acc}m` : ''})`,
          'success'
        );
        fetchMyLocationBtn.disabled = false;
        fetchMyLocationBtn.textContent = '현재 내 위치 좌표 불러오기';
      },
      () => {
        setLocationStatus(
          '위치 정보를 불러올 수 없습니다. 브라우저의 위치 권한을 허용하거나 좌표를 직접 입력해주세요.',
          'error'
        );
        fetchMyLocationBtn.disabled = false;
        fetchMyLocationBtn.textContent = '현재 내 위치 좌표 불러오기';
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });

  // --------------------------------------------------------------------------
  // 2. 출석부 1줄 가로 그리드 행 생성 / 삭제 / 갱신 (이름 | 생년월일 6자리 | 성별 | ×)
  // --------------------------------------------------------------------------
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

    // ② 생년월일 6자리 숫자 직접 입력칸
    const birthInput = document.createElement('input');
    birthInput.type = 'text';
    birthInput.className = 'form-input roster-birth-input';
    birthInput.setAttribute('inputmode', 'numeric');
    birthInput.setAttribute('pattern', '[0-9]*');
    birthInput.maxLength = 6;
    birthInput.placeholder = '예: 960211';
    birthInput.setAttribute('autocomplete', 'off');
    birthInput.setAttribute('aria-label', '생년월일 6자리');
    if (initialData && initialData.birthDate) {
      birthInput.value = formatIsoToBirth6(initialData.birthDate);
    }

    birthInput.addEventListener('input', () => {
      const digitsOnly = birthInput.value.replace(/\D/g, '').slice(0, 6);
      if (birthInput.value !== digitsOnly) {
        birthInput.value = digitsOnly;
      }
      birthInput.classList.remove('is-invalid');
      hideCreateAlert();
    });

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
    row.appendChild(birthInput);
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

    rows.forEach((row) => {
      row.querySelector('.roster-name-input').classList.remove('is-invalid');
      row.querySelector('.roster-birth-input').classList.remove('is-invalid');
      row.querySelector('.gender-segment').classList.remove('is-invalid');
    });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 1;
      const nameInput = row.querySelector('.roster-name-input');
      const birthInput = row.querySelector('.roster-birth-input');
      const genderSegment = row.querySelector('.gender-segment');

      const cleanedName = nameInput.value.replace(/\s+/g, '');
      const rawBirth = birthInput.value.replace(/\D/g, '');
      const gender = row.dataset.gender || '';

      // 완전히 비어있는 행은 무시
      if (!cleanedName && !rawBirth && !gender) {
        continue;
      }

      // 이름 누락 경고
      if (!cleanedName) {
        nameInput.classList.add('is-invalid');
        nameInput.focus();
        return {
          valid: false,
          message: `출석부 ${rowNum}번째 행의 이름을 입력해주세요. (사용하지 않는 행은 삭제해주세요)`,
        };
      }

      // 이름 검증
      const nameCheck = validateKoreanName(cleanedName);
      if (!nameCheck.valid) {
        nameInput.classList.add('is-invalid');
        nameInput.focus();
        return {
          valid: false,
          message: `출석부 ${rowNum}번째 행: ${nameCheck.message}`,
        };
      }

      // 생년월일 6자리 검증 및 YYYY-MM-DD 변환
      const birthCheck = parseBirthDate6(rawBirth);
      if (!birthCheck.valid) {
        birthInput.classList.add('is-invalid');
        birthInput.focus();
        return {
          valid: false,
          message: `출석부 ${rowNum}번째 행(${nameCheck.cleanedName}): ${birthCheck.message}`,
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
      const personKey = `${nameCheck.cleanedName}|${birthCheck.iso}`;
      if (seenPersonKeys.has(personKey)) {
        nameInput.classList.add('is-invalid');
        nameInput.focus();
        return {
          valid: false,
          message: `출석부 ${rowNum}번째 행(${nameCheck.cleanedName}, ${birthCheck.iso})이 중복 입력되었습니다.`,
        };
      }

      seenPersonKeys.add(personKey);
      validEntries.push({
        name: nameCheck.cleanedName,
        birthDate: birthCheck.iso,
        gender,
      });
    }

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
    inputIsMultiSession.checked = false;
    inputLocationEnabled.checked = false;
    inputAllowedRadius.value = '300';
    inputManagerCode.value = generateManagerCode();
    syncLocationFieldsVisibility();
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
    inputIsMultiSession.checked = Boolean(program.isMultiSession);
    inputProgramTime.value = program.time || '';
    inputInstructor.value = program.instructor || '';

    inputLocationEnabled.checked = Boolean(program.locationEnabled);
    inputLocationName.value = program.locationName || '';
    inputLatitude.value = program.latitude || '';
    inputLongitude.value = program.longitude || '';
    inputAllowedRadius.value = String(program.allowedRadius || 300);
    inputManagerCode.value = program.managerCode || '';
    syncLocationFieldsVisibility();
    setLocationStatus('');

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
    resultDateTime.textContent =
      `${program.date} · ${program.time}` +
      (program.isMultiSession ? ' (다회차 · 날짜 제한 해제)' : '');
    resultInstructor.textContent = program.instructor;
    resultRosterCount.textContent =
      roster.length > 0
        ? `출석부 ${roster.length}명 (가나다순 정렬 완료)`
        : '현장 등록 모드 (0명 / 인원 제한 없음)';

    if (program.locationEnabled) {
      const placeLabel = program.locationName ? `${program.locationName} · ` : '';
      resultLocationText.textContent = `${placeLabel}반경 ${program.allowedRadius}m 이내`;
      resultLocationRow.classList.remove('hidden');
    } else {
      resultLocationRow.classList.add('hidden');
    }

    if (program.managerCode) {
      resultManagerCodeText.textContent = program.managerCode;
      resultManagerCodeRow.classList.remove('hidden');
    } else {
      resultManagerCodeRow.classList.add('hidden');
    }

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
    const isMultiSession = Boolean(inputIsMultiSession.checked);
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

    // 위치 기반 출석 제한 설정 검증
    const locationEnabled = Boolean(inputLocationEnabled.checked);
    let locationName = '';
    let latitude = '';
    let longitude = '';
    let allowedRadius = 300;
    const managerCode = inputManagerCode.value.trim();

    if (locationEnabled) {
      locationName = inputLocationName.value.trim();
      latitude = inputLatitude.value.trim();
      longitude = inputLongitude.value.trim();
      allowedRadius = Number(inputAllowedRadius.value) || 300;

      const latNum = Number(latitude);
      const lngNum = Number(longitude);
      if (!latitude || isNaN(latNum) || latNum < -90 || latNum > 90) {
        showCreateAlert('올바른 기준 위도(Latitude, -90 ~ 90)를 입력하거나 현재 위치를 불러와주세요.');
        inputLatitude.focus();
        return;
      }
      if (!longitude || isNaN(lngNum) || lngNum < -180 || lngNum > 180) {
        showCreateAlert('올바른 기준 경도(Longitude, -180 ~ 180)를 입력하거나 현재 위치를 불러와주세요.');
        inputLongitude.focus();
        return;
      }
    }

    if (!managerCode) {
      showCreateAlert('현장 수동 출석 승인용 담당자 확인 코드를 입력해주세요.');
      inputManagerCode.focus();
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
      const payload = {
        code: targetCode,
        name,
        date,
        time,
        instructor,
        roster: rosterValidation.roster,
        isMultiSession,
        locationEnabled,
        locationName,
        latitude,
        longitude,
        allowedRadius,
        managerCode,
      };

      const savedProgram = isEditing
        ? await updateExistingProgram(payload)
        : await saveNewProgram(payload);

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
      badges.appendChild(codeBadge);

      if (program.isMultiSession) {
        const multiBadge = document.createElement('span');
        multiBadge.className = 'badge badge--test';
        multiBadge.textContent = '다회차';
        badges.appendChild(multiBadge);
      }

      if (program.locationEnabled) {
        const locBadge = document.createElement('span');
        locBadge.className = 'badge badge--primary';
        locBadge.textContent = `GPS ${program.allowedRadius}m`;
        badges.appendChild(locBadge);
      }

      const modeBadge = document.createElement('span');
      if (roster.length > 0) {
        modeBadge.className = 'badge badge--primary';
        modeBadge.textContent = `출석부 ${roster.length}명`;
      } else {
        modeBadge.className = 'badge badge--open';
        modeBadge.textContent = '현장 등록';
      }
      badges.appendChild(modeBadge);

      top.appendChild(nameEl);
      top.appendChild(badges);

      // 메타: 일시, 강사명, 위치/담당자코드, 생성일시
      const meta = document.createElement('div');
      meta.className = 'program-item-meta';

      const dateSpan = document.createElement('span');
      dateSpan.textContent = `일시: ${program.date} ${program.time}`;
      meta.appendChild(dateSpan);

      const instructorSpan = document.createElement('span');
      instructorSpan.textContent = `강사: ${program.instructor}`;
      meta.appendChild(instructorSpan);

      if (program.locationEnabled) {
        const locSpan = document.createElement('span');
        const placeText = program.locationName ? `${program.locationName} ` : '';
        locSpan.textContent = `위치: ${placeText}(반경 ${program.allowedRadius}m)`;
        meta.appendChild(locSpan);
      }

      if (program.managerCode) {
        const codeSpan = document.createElement('span');
        codeSpan.textContent = `확인코드: ${program.managerCode}`;
        meta.appendChild(codeSpan);
      }

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
