/**
 * 광주시 청년지원센터 - 참가자 본인 출석 등록 페이지 로직 (app.js)
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

const STORAGE_KEY_PROGRAMS = 'gjyouth_programs';
const STORAGE_KEY_PARTICIPANTS = 'gjyouth_participants';
const STORAGE_KEY_DEVICE_ID = 'gjyouth_device_id';
const STORAGE_KEY_SUBMITTED_MAP = 'gjyouth_submitted_records';

const IDB_NAME = 'gjyouth_attendance_db';
const IDB_VERSION = 1;
const IDB_STORE_META = 'device_meta';
const IDB_STORE_SUBMITTED = 'submitted_records';

const BIRTH_YEAR_MAX = 2012;
const BIRTH_YEAR_MIN = 1960;
const BIRTH_YEAR_DEFAULT = 2000;
const BIRTH_MONTH_DEFAULT = 1;
const BIRTH_DAY_DEFAULT = 1;

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

const ERROR_MSG_NOT_IN_ROSTER = '출석부에 등록되어있지 않은 정보입니다.';
const ERROR_MSG_DEVICE_DUPLICATE = '이미 이 기기에서 출석 등록이 완료되었습니다.';
const ERROR_MSG_PARTICIPANT_DUPLICATE = '이미 출석 처리가 완료된 참가자입니다.';

let currentProgram = null;
let currentDeviceId = '';
let currentDeviceFingerprint = '';

// ============================================================================
// 기기 식별자 (localStorage + IndexedDB) 및 보조 지문(deviceFingerprint)
// ============================================================================

function generateUuidV4() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isValidUuidV4(val) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(val || '').trim()
  );
}

function openAttendanceDb() {
  return new Promise((resolve) => {
    if (!window.indexedDB) {
      resolve(null);
      return;
    }
    try {
      const request = window.indexedDB.open(IDB_NAME, IDB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE_META)) {
          db.createObjectStore(IDB_STORE_META);
        }
        if (!db.objectStoreNames.contains(IDB_STORE_SUBMITTED)) {
          db.createObjectStore(IDB_STORE_SUBMITTED);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch (err) {
      resolve(null);
    }
  });
}

async function idbGet(storeName, key) {
  const db = await openAttendanceDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => {
        db.close();
        resolve(req.result !== undefined ? req.result : null);
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch (err) {
      try { db.close(); } catch (e) {}
      resolve(null);
    }
  });
}

async function idbSet(storeName, key, value) {
  const db = await openAttendanceDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).put(value, key);
      req.onsuccess = () => {
        db.close();
        resolve(true);
      };
      req.onerror = () => {
        db.close();
        resolve(false);
      };
    } catch (err) {
      try { db.close(); } catch (e) {}
      resolve(false);
    }
  });
}

/**
 * localStorage와 IndexedDB 양쪽에 영구 저장되는 고유 기기 식별자(gjyouth_device_id) 획득
 */
async function ensurePersistentDeviceId() {
  let lsId = '';
  try {
    lsId = String(localStorage.getItem(STORAGE_KEY_DEVICE_ID) || '').trim();
  } catch (err) {
    lsId = '';
  }

  let idbId = '';
  try {
    const raw = await idbGet(IDB_STORE_META, STORAGE_KEY_DEVICE_ID);
    idbId = String(raw || '').trim();
  } catch (err) {
    idbId = '';
  }

  let resolvedId = '';
  if (isValidUuidV4(lsId)) {
    resolvedId = lsId;
  } else if (isValidUuidV4(idbId)) {
    resolvedId = idbId;
  } else {
    resolvedId = generateUuidV4();
  }

  // 양쪽 스토리지 동기화 유지
  try {
    localStorage.setItem(STORAGE_KEY_DEVICE_ID, resolvedId);
  } catch (err) {}
  await idbSet(IDB_STORE_META, STORAGE_KEY_DEVICE_ID, resolvedId);

  return resolvedId;
}

/**
 * 브라우저 하드웨어/환경 특성 기반 보조 지문(deviceFingerprint) 생성
 */
async function generateDeviceFingerprint() {
  let canvasSig = '';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 220;
    canvas.height = 40;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial, sans-serif';
      ctx.fillStyle = '#1d63ed';
      ctx.fillRect(10, 4, 90, 20);
      ctx.fillStyle = '#0f172a';
      ctx.fillText('gjyouth-fp-v1', 14, 10);
      canvasSig = canvas.toDataURL().slice(-64);
    }
  } catch (err) {
    canvasSig = 'nocanvas';
  }

  let timezone = '';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch (err) {
    timezone = String(new Date().getTimezoneOffset());
  }

  const rawSignals = [
    navigator.userAgent || '',
    navigator.language || '',
    Array.isArray(navigator.languages) ? navigator.languages.join(',') : '',
    navigator.platform || '',
    String(navigator.hardwareConcurrency || ''),
    String(navigator.deviceMemory || ''),
    String(navigator.maxTouchPoints || 0),
    `${window.screen ? window.screen.width : 0}x${window.screen ? window.screen.height : 0}`,
    String(window.screen ? window.screen.colorDepth : 0),
    String(window.devicePixelRatio || 1),
    timezone,
    canvasSig,
  ].join('|');

  // SHA-256 해시 (Web Crypto API 사용 가능 시)
  if (window.crypto && window.crypto.subtle && window.TextEncoder) {
    try {
      const encoded = new TextEncoder().encode(rawSignals);
      const digest = await window.crypto.subtle.digest('SHA-256', encoded);
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return `fp_${hex.slice(0, 32)}`;
    } catch (err) {
      // 폴백 해시 사용
    }
  }

  // 비보안 컨텍스트(http:// 등)용 결정적 64비트 폴백 해시
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < rawSignals.length; i++) {
    const ch = rawSignals.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined =
    (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  return `fp_${combined}`;
}

function buildSubmissionKey(programCode, attendanceDate) {
  return `${programCode}::${attendanceDate}`;
}

function getLocalSubmittedMap() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SUBMITTED_MAP);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

async function hasDeviceSubmittedLocally(programCode, attendanceDate) {
  const key = buildSubmissionKey(programCode, attendanceDate);

  // 1) localStorage 기록 확인
  const map = getLocalSubmittedMap();
  if (map[key]) {
    return map[key];
  }

  // 2) IndexedDB 기록 확인 (localStorage만 비웠을 때 복원/차단)
  const idbRecord = await idbGet(IDB_STORE_SUBMITTED, key);
  if (idbRecord) {
    try {
      map[key] = idbRecord;
      localStorage.setItem(STORAGE_KEY_SUBMITTED_MAP, JSON.stringify(map));
    } catch (err) {}
    return idbRecord;
  }

  // 3) 테스트 모드인 경우 참가자명단 저장소에서도 기기ID/지문으로 대조
  if (IS_TEST_MODE) {
    const participants = getLocalParticipants();
    const matched = participants.find(
      (row) =>
        row.programCode === programCode &&
        row.attendanceDate === attendanceDate &&
        ((currentDeviceId && row.deviceId === currentDeviceId) ||
          (currentDeviceFingerprint && row.deviceFingerprint === currentDeviceFingerprint))
    );
    if (matched) {
      return {
        programName: matched.programName,
        attendanceDate: matched.attendanceDate,
      };
    }
  }

  return null;
}

async function markDeviceSubmittedLocally(programCode, attendanceDate, meta = {}) {
  const key = buildSubmissionKey(programCode, attendanceDate);
  const record = {
    programCode,
    programName: meta.programName || '',
    attendanceDate,
    submittedAt: new Date().toISOString(),
  };

  try {
    const map = getLocalSubmittedMap();
    map[key] = record;
    localStorage.setItem(STORAGE_KEY_SUBMITTED_MAP, JSON.stringify(map));
  } catch (err) {}

  await idbSet(IDB_STORE_SUBMITTED, key, record);
}

// ============================================================================
// 날짜 / 연령구분 / 유효성 검증 유틸리티
// ============================================================================

/**
 * 접속 시점의 시스템 현지 날짜를 YYYY/MM/DD 형식으로 반환
 */
function getSystemLocalAttendanceDate(dateObj = new Date()) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

/**
 * 한국 표준시(Asia/Seoul) 기준 등록날짜(yyyy-MM-dd), 등록시간(HH:mm:ss), 등록연도 반환
 */
function getKstDateTimeParts(dateObj = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(dateObj);
    const map = {};
    parts.forEach((p) => {
      map[p.type] = p.value;
    });
    const hour = map.hour === '24' ? '00' : map.hour;
    if (map.year && map.month && map.day) {
      return {
        year: Number(map.year),
        regDate: `${map.year}-${map.month}-${map.day}`,
        regTime: `${hour}:${map.minute}:${map.second}`,
      };
    }
  } catch (err) {
    // 폴백: UTC+9 계산
  }
  const kst = new Date(dateObj.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    year: y,
    regDate: `${y}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}`,
    regTime: `${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(kst.getUTCSeconds())}`,
  };
}

/**
 * 연도별 청년 연령 자동 계산 (하드코딩 금지)
 * - 등록 연도(currentYear) 기준 연 나이 19세~39세
 *   (currentYear - 39 이상 currentYear - 19 이하) => '청년', 그 외 => '청년외'
 *   예: 2026년 -> 1987~2007년생 청년 / 2027년 -> 1988~2008년생 청년
 */
function calculateAgeGroup(birthDateStr, referenceYear) {
  const currentYear = Number(referenceYear) || getKstDateTimeParts().year;
  const match = String(birthDateStr || '').trim().match(/^(\d{4})/);
  if (!match) return '청년외';

  const birthYear = parseInt(match[1], 10);
  const minYouthYear = currentYear - 39;
  const maxYouthYear = currentYear - 19;

  if (birthYear >= minYouthYear && birthYear <= maxYouthYear) {
    return '청년';
  }
  return '청년외';
}

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

  return source
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const name = String(entry.name || '').replace(/\s+/g, '');
      if (!name) return null;
      return {
        name,
        birthDate: String(entry.birthDate || '').trim(),
        gender: normalizeGender(entry.gender),
      };
    })
    .filter(Boolean);
}

/**
 * 참가자명 검증: 공백 제거 후 한글 완성형 2~5자, 동일 글자 3회 연속 반복 금지, 블랙리스트 차단
 */
function validateParticipantName(rawValue) {
  const cleaned = String(rawValue || '').replace(/\s+/g, '');

  if (!cleaned) {
    return { valid: false, message: '참가자명을 입력해주세요.' };
  }
  if (!/^[가-힣]{2,5}$/.test(cleaned)) {
    return {
      valid: false,
      message: '한글 2~5글자 완성형 이름만 입력할 수 있습니다.',
    };
  }
  if (/(.)\1{2,}/.test(cleaned)) {
    return {
      valid: false,
      message: '동일한 글자를 3회 이상 반복하여 입력할 수 없습니다.',
    };
  }
  if (NAME_BLACKLIST.includes(cleaned)) {
    return {
      valid: false,
      message: '올바른 실명을 입력해주세요.',
    };
  }

  return { valid: true, cleanedName: cleaned };
}

/**
 * 출석부 명단(이름 + 생년월일 + 성별) 정확 일치 대조
 */
function verifyRosterMatch({ name, birthDate, gender }, rawRoster) {
  const roster = normalizeRosterList(rawRoster);
  if (roster.length === 0) {
    return { matched: true };
  }

  const normalizedGender = normalizeGender(gender);
  const exactMatch = roster.some(
    (entry) =>
      entry.name === name &&
      entry.birthDate === birthDate &&
      normalizeGender(entry.gender) === normalizedGender
  );

  if (!exactMatch) {
    return {
      matched: false,
      message: ERROR_MSG_NOT_IN_ROSTER,
    };
  }

  return { matched: true };
}

// ============================================================================
// 데이터 레이어 (localStorage 테스트 모드 / GAS 실연동 모드)
// ============================================================================

function getLocalPrograms() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PROGRAMS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function getLocalParticipants() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PARTICIPANTS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function saveLocalParticipants(list) {
  localStorage.setItem(STORAGE_KEY_PARTICIPANTS, JSON.stringify(list));
}

async function fetchProgramByCode(code, deviceCheck = {}) {
  if (IS_TEST_MODE) {
    const programs = getLocalPrograms();
    const found = programs.find((item) => item.code === code);
    if (!found) return null;
    const roster = normalizeRosterList(found.roster || found.preRegisteredList);
    return {
      ...found,
      roster,
      preRegisteredList: roster,
    };
  }

  if (!GAS_WEB_APP_URL) {
    throw new Error('GAS_WEB_APP_URL이 설정되지 않았습니다.');
  }

  const requestUrl = new URL(GAS_WEB_APP_URL);
  requestUrl.searchParams.set('action', 'getProgram');
  requestUrl.searchParams.set('code', code);
  if (deviceCheck.deviceId) {
    requestUrl.searchParams.set('deviceId', deviceCheck.deviceId);
  }
  if (deviceCheck.deviceFingerprint) {
    requestUrl.searchParams.set('deviceFingerprint', deviceCheck.deviceFingerprint);
  }
  if (deviceCheck.attendanceDate) {
    requestUrl.searchParams.set('attendanceDate', deviceCheck.attendanceDate);
  }

  const response = await fetch(requestUrl.toString(), {
    method: 'GET',
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`서버 응답 오류 (HTTP ${response.status})`);
  }

  const result = await response.json();
  if (result.status === 'success' && result.data) {
    return result.data;
  }
  return null;
}

async function submitAttendanceRecord(payload) {
  if (IS_TEST_MODE) {
    const programs = getLocalPrograms();
    const program = programs.find((item) => item.code === payload.programCode);
    if (!program) {
      return {
        status: 'not_found',
        message: '유효하지 않은 프로그램입니다.',
      };
    }

    // 1) 출석부 명단이 등록되어 있는 경우 이름 + 생년월일 + 성별 정확 일치 대조
    const roster = normalizeRosterList(program.roster || program.preRegisteredList);
    const rosterCheck = verifyRosterMatch(
      {
        name: payload.participantName,
        birthDate: payload.birthDate,
        gender: payload.gender,
      },
      roster
    );
    if (!rosterCheck.matched) {
      return {
        status: 'not_in_roster',
        message: ERROR_MSG_NOT_IN_ROSTER,
      };
    }

    const participants = getLocalParticipants();

    // 2) 같은 프로그램코드 + 출석일자 내 동일 기기(deviceId 또는 deviceFingerprint) 차단
    const isDeviceDuplicate = participants.some(
      (row) =>
        row.programCode === payload.programCode &&
        row.attendanceDate === payload.attendanceDate &&
        ((payload.deviceId && row.deviceId === payload.deviceId) ||
          (payload.deviceFingerprint && row.deviceFingerprint === payload.deviceFingerprint))
    );
    if (isDeviceDuplicate) {
      return {
        status: 'device_duplicate',
        message: ERROR_MSG_DEVICE_DUPLICATE,
      };
    }

    // 3) 같은 프로그램코드 + 출석일자 내 동일 참가자(참가자명 + 생년월일) 중복 차단
    const isParticipantDuplicate = participants.some(
      (row) =>
        row.programCode === payload.programCode &&
        row.attendanceDate === payload.attendanceDate &&
        row.participantName === payload.participantName &&
        row.birthDate === payload.birthDate
    );
    if (isParticipantDuplicate) {
      return {
        status: 'duplicate',
        message: ERROR_MSG_PARTICIPANT_DUPLICATE,
      };
    }

    const kst = getKstDateTimeParts();
    const ageGroup = calculateAgeGroup(payload.birthDate, kst.year);

    const record = {
      regDate: kst.regDate,
      regTime: kst.regTime,
      programCode: payload.programCode,
      programName: program.name,
      attendanceDate: payload.attendanceDate,
      participantName: payload.participantName,
      birthDate: payload.birthDate,
      ageGroup,
      gender: payload.gender,
      privacyConsent: payload.privacyConsent,
      deviceId: payload.deviceId,
      deviceFingerprint: payload.deviceFingerprint,
    };

    participants.push(record);
    saveLocalParticipants(participants);

    return {
      status: 'success',
      message: '출석이 완료되었습니다.',
      data: record,
    };
  }

  if (!GAS_WEB_APP_URL) {
    throw new Error('GAS_WEB_APP_URL이 설정되지 않았습니다.');
  }

  const response = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    redirect: 'follow',
    body: JSON.stringify({
      action: 'registerParticipant',
      ...payload,
    }),
  });

  if (!response.ok) {
    throw new Error(`서버 응답 오류 (HTTP ${response.status})`);
  }

  return response.json();
}

// ============================================================================
// UI 초기화 및 이벤트 처리
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  // 화면 섹션
  const loadingSection = document.getElementById('loadingSection');
  const invalidSection = document.getElementById('invalidSection');
  const invalidMessage = document.getElementById('invalidMessage');
  const alreadySubmittedSection = document.getElementById('alreadySubmittedSection');
  const alreadySummaryBox = document.getElementById('alreadySummaryBox');
  const alreadyProgramName = document.getElementById('alreadyProgramName');
  const alreadyAttendanceDate = document.getElementById('alreadyAttendanceDate');
  const formSection = document.getElementById('formSection');
  const completeSection = document.getElementById('completeSection');
  const testModeBadge = document.getElementById('testModeBadge');

  // 폼 필드
  const attendanceForm = document.getElementById('attendanceForm');
  const programNameInput = document.getElementById('programName');
  const programSchedule = document.getElementById('programSchedule');
  const programInstructor = document.getElementById('programInstructor');
  const attendanceDateInput = document.getElementById('attendanceDate');
  const participantNameInput = document.getElementById('participantName');
  const birthYearSelect = document.getElementById('birthYear');
  const birthMonthSelect = document.getElementById('birthMonth');
  const birthDaySelect = document.getElementById('birthDay');
  const genderSegment = document.getElementById('genderSegment');
  const genderValueInput = document.getElementById('genderValue');
  const submitBtn = document.getElementById('submitBtn');

  // 오류 표시 요소
  const nameError = document.getElementById('nameError');
  const birthError = document.getElementById('birthError');
  const genderError = document.getElementById('genderError');
  const consentError = document.getElementById('consentError');
  const formAlert = document.getElementById('formAlert');

  // 완료 화면 요약 요소
  const summaryProgramName = document.getElementById('summaryProgramName');
  const summaryAttendanceDate = document.getElementById('summaryAttendanceDate');
  const summaryParticipantName = document.getElementById('summaryParticipantName');

  if (IS_TEST_MODE && testModeBadge) {
    testModeBadge.classList.remove('hidden');
  }

  // --------------------------------------------------------------------------
  // 1. 생년월일 드롭다운 초기화 (연도 2012~1960 기본 2000, 윤년/말일 자동 보정)
  // --------------------------------------------------------------------------
  function populateDayOptions(year, month, preferredDay) {
    const maxDays = getDaysInMonth(year, month);
    const targetDay = Math.min(Number(preferredDay) || 1, maxDays);
    birthDaySelect.innerHTML = '';
    for (let d = 1; d <= maxDays; d++) {
      const opt = document.createElement('option');
      opt.value = String(d).padStart(2, '0');
      opt.textContent = `${d}일`;
      if (d === targetDay) opt.selected = true;
      birthDaySelect.appendChild(opt);
    }
  }

  function initBirthDateDropdowns() {
    birthYearSelect.innerHTML = '';
    for (let y = BIRTH_YEAR_MAX; y >= BIRTH_YEAR_MIN; y--) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = `${y}년`;
      if (y === BIRTH_YEAR_DEFAULT) opt.selected = true;
      birthYearSelect.appendChild(opt);
    }

    birthMonthSelect.innerHTML = '';
    for (let m = 1; m <= 12; m++) {
      const opt = document.createElement('option');
      opt.value = String(m).padStart(2, '0');
      opt.textContent = `${m}월`;
      if (m === BIRTH_MONTH_DEFAULT) opt.selected = true;
      birthMonthSelect.appendChild(opt);
    }

    populateDayOptions(BIRTH_YEAR_DEFAULT, BIRTH_MONTH_DEFAULT, BIRTH_DAY_DEFAULT);

    const syncDays = () => {
      populateDayOptions(
        Number(birthYearSelect.value),
        Number(birthMonthSelect.value),
        Number(birthDaySelect.value)
      );
      clearFieldError(birthError, [birthYearSelect, birthMonthSelect, birthDaySelect]);
      hideFormAlert();
    };

    birthYearSelect.addEventListener('change', syncDays);
    birthMonthSelect.addEventListener('change', syncDays);
    birthDaySelect.addEventListener('change', () => {
      clearFieldError(birthError, [birthYearSelect, birthMonthSelect, birthDaySelect]);
      hideFormAlert();
    });
  }

  initBirthDateDropdowns();

  // --------------------------------------------------------------------------
  // 2. 성별 버튼식 선택 ([남] / [여])
  // --------------------------------------------------------------------------
  const genderButtons = Array.from(genderSegment.querySelectorAll('.gender-segment-btn'));
  genderButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const selected = btn.dataset.gender;
      genderValueInput.value = selected;
      genderSegment.classList.remove('is-invalid');
      genderButtons.forEach((b) => {
        const isActive = b.dataset.gender === selected;
        b.classList.toggle('is-active', isActive);
        b.setAttribute('aria-checked', String(isActive));
      });
      clearFieldError(genderError);
      hideFormAlert();
    });
  });

  // --------------------------------------------------------------------------
  // 3. 오류 표시 헬퍼
  // --------------------------------------------------------------------------
  function showFieldError(errorEl, message, inputEls = []) {
    errorEl.textContent = message;
    errorEl.classList.add('visible');
    inputEls.forEach((el) => el && el.classList.add('is-invalid'));
  }

  function clearFieldError(errorEl, inputEls = []) {
    errorEl.textContent = '';
    errorEl.classList.remove('visible');
    inputEls.forEach((el) => el && el.classList.remove('is-invalid'));
  }

  function showFormAlert(message) {
    formAlert.textContent = message;
    formAlert.classList.remove('hidden');
  }

  function hideFormAlert() {
    formAlert.textContent = '';
    formAlert.classList.add('hidden');
  }

  participantNameInput.addEventListener('input', () => {
    clearFieldError(nameError, [participantNameInput]);
    hideFormAlert();
  });

  document.querySelectorAll('input[name="privacyConsent"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      clearFieldError(consentError);
      hideFormAlert();
    });
  });

  // --------------------------------------------------------------------------
  // 4. 화면 전환 헬퍼
  // --------------------------------------------------------------------------
  function hideAllSections() {
    loadingSection.classList.add('hidden');
    invalidSection.classList.add('hidden');
    alreadySubmittedSection.classList.add('hidden');
    formSection.classList.add('hidden');
    completeSection.classList.add('hidden');
  }

  function showInvalidScreen(customMessage) {
    hideAllSections();
    if (customMessage) {
      invalidMessage.textContent = customMessage;
    }
    invalidSection.classList.remove('hidden');
  }

  function showAlreadySubmittedScreen(info = {}) {
    hideAllSections();
    if (info.programName || info.attendanceDate) {
      alreadyProgramName.textContent = info.programName || '';
      alreadyAttendanceDate.textContent = info.attendanceDate || '';
      alreadySummaryBox.classList.remove('hidden');
    } else {
      alreadySummaryBox.classList.add('hidden');
    }
    alreadySubmittedSection.classList.remove('hidden');
  }

  function showFormScreen(program, attendanceDate) {
    currentProgram = program;

    programNameInput.value = program.name;
    programSchedule.textContent = `${program.date} · ${program.time}`;
    programInstructor.textContent = `강사: ${program.instructor}`;
    attendanceDateInput.value = attendanceDate;

    hideFormAlert();
    hideAllSections();
    formSection.classList.remove('hidden');
  }

  function showCompleteScreen(summary) {
    summaryProgramName.textContent = summary.programName;
    summaryAttendanceDate.textContent = summary.attendanceDate;
    summaryParticipantName.textContent = summary.participantName;

    hideAllSections();
    completeSection.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // --------------------------------------------------------------------------
  // 5. 초기 진입: 기기 식별자 생성 -> 프로그램 조회 -> 동일 기기 기출석 여부 즉시 확인
  // --------------------------------------------------------------------------
  async function initPage() {
    const params = new URLSearchParams(window.location.search);
    const code = (params.get('code') || '').trim();

    if (!code) {
      showInvalidScreen(
        '유효하지 않은 프로그램 접근입니다. 현장에 비치된 QR코드를 다시 스캔해주세요.'
      );
      return;
    }

    const attendanceDate = getSystemLocalAttendanceDate();

    try {
      // 기기 고유 식별자(localStorage + IndexedDB) 및 보조 지문 생성
      const [deviceId, deviceFingerprint] = await Promise.all([
        ensurePersistentDeviceId(),
        generateDeviceFingerprint(),
      ]);
      currentDeviceId = deviceId;
      currentDeviceFingerprint = deviceFingerprint;

      // 프로그램 정보 조회
      const program = await fetchProgramByCode(code, {
        deviceId,
        deviceFingerprint,
        attendanceDate,
      });

      if (!program) {
        showInvalidScreen(
          '유효하지 않은 프로그램 접근입니다. 현장에 비치된 QR코드를 다시 스캔해주세요.'
        );
        return;
      }

      // 동일 기기로 동일 프로그램·동일 출석일자에 이미 출석한 경우 폼 숨기고 즉시 안내 표시
      const localPrev = await hasDeviceSubmittedLocally(program.code, attendanceDate);
      if (localPrev || program.alreadySubmittedOnDevice) {
        await markDeviceSubmittedLocally(program.code, attendanceDate, {
          programName: program.name,
        });
        showAlreadySubmittedScreen({
          programName: program.name,
          attendanceDate,
        });
        return;
      }

      showFormScreen(program, attendanceDate);
    } catch (err) {
      showInvalidScreen(
        '프로그램 정보를 불러오는 중 오류가 발생했습니다. 잠시 후 QR코드를 다시 스캔해주세요.'
      );
    }
  }

  // --------------------------------------------------------------------------
  // 6. 본인 출석 등록 제출 처리
  // --------------------------------------------------------------------------
  attendanceForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentProgram) return;

    hideFormAlert();
    clearFieldError(nameError, [participantNameInput]);
    clearFieldError(birthError, [birthYearSelect, birthMonthSelect, birthDaySelect]);
    clearFieldError(genderError, [genderSegment]);
    clearFieldError(consentError);

    let firstInvalidEl = null;

    // 1) 이름 검증 (공백 제거 후 한글 완성형 2~5자, 3회 연속 반복 금지, 블랙리스트 차단)
    const nameCheck = validateParticipantName(participantNameInput.value);
    if (!nameCheck.valid) {
      showFieldError(nameError, nameCheck.message, [participantNameInput]);
      firstInvalidEl = firstInvalidEl || participantNameInput;
    }

    // 2) 생년월일 조합 (YYYY-MM-DD)
    const yearVal = birthYearSelect.value;
    const monthVal = birthMonthSelect.value;
    const dayVal = birthDaySelect.value;
    const birthDate = `${yearVal}-${monthVal}-${dayVal}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
      showFieldError(birthError, '생년월일을 올바르게 선택해주세요.', [
        birthYearSelect,
        birthMonthSelect,
        birthDaySelect,
      ]);
      firstInvalidEl = firstInvalidEl || birthYearSelect;
    }

    // 3) 성별 검증
    const genderVal = genderValueInput.value;
    if (genderVal !== '남' && genderVal !== '여') {
      showFieldError(genderError, '성별을 선택해주세요.', [genderSegment]);
      firstInvalidEl = firstInvalidEl || genderButtons[0];
    }

    // 4) 개인정보 수집·이용 동의 검증
    const consentInput = document.querySelector('input[name="privacyConsent"]:checked');
    const consentVal = consentInput ? consentInput.value : '';
    if (consentVal !== '동의함') {
      showFieldError(
        consentError,
        '개인정보 수집 및 이용에 동의하셔야 출석 등록이 가능합니다.'
      );
      firstInvalidEl = firstInvalidEl || document.querySelector('input[name="privacyConsent"]');
    }

    if (firstInvalidEl) {
      firstInvalidEl.focus();
      return;
    }

    const attendanceDate = attendanceDateInput.value || getSystemLocalAttendanceDate();

    // 5) 출석부 명단 대조 (로컬 테스트 모드 또는 명단이 내려온 경우 1차 검증; GAS 모드에서는 서버에서도 최종 대조)
    const roster = normalizeRosterList(
      currentProgram.roster || currentProgram.preRegisteredList
    );
    if (roster.length > 0) {
      const rosterCheck = verifyRosterMatch(
        {
          name: nameCheck.cleanedName,
          birthDate,
          gender: genderVal,
        },
        roster
      );
      if (!rosterCheck.matched) {
        showFormAlert(ERROR_MSG_NOT_IN_ROSTER);
        return;
      }
    }

    submitBtn.disabled = true;
    submitBtn.textContent = '출석 등록 중...';

    try {
      const result = await submitAttendanceRecord({
        programCode: currentProgram.code,
        programName: currentProgram.name,
        attendanceDate,
        participantName: nameCheck.cleanedName,
        birthDate,
        gender: genderVal,
        privacyConsent: consentVal,
        deviceId: currentDeviceId,
        deviceFingerprint: currentDeviceFingerprint,
      });

      if (result.status === 'success') {
        await markDeviceSubmittedLocally(currentProgram.code, attendanceDate, {
          programName: currentProgram.name,
        });
        showCompleteScreen({
          programName: currentProgram.name,
          attendanceDate,
          participantName: nameCheck.cleanedName,
        });
        return;
      }

      if (result.status === 'device_duplicate') {
        await markDeviceSubmittedLocally(currentProgram.code, attendanceDate, {
          programName: currentProgram.name,
        });
        showAlreadySubmittedScreen({
          programName: currentProgram.name,
          attendanceDate,
        });
        return;
      }

      showFormAlert(result.message || '출석 등록에 실패했습니다. 입력 내용을 다시 확인해주세요.');
    } catch (err) {
      showFormAlert(
        '서버와의 통신 중 오류가 발생했습니다. 네트워크 상태를 확인 후 다시 시도해주세요.'
      );
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '출석 등록하기';
    }
  });

  initPage();
});
