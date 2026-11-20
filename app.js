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
const SESSION_KEY_QR_ACCESS = 'gjyouth_qr_access_session';
const QR_SESSION_TTL_MS = 3 * 60 * 1000; // QR 스캔 후 3분 유효

const IDB_NAME = 'gjyouth_attendance_db';
const IDB_VERSION = 1;
const IDB_STORE_META = 'device_meta';
const IDB_STORE_SUBMITTED = 'submitted_records';

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

const ERROR_MSG_INVALID_BIRTH6 = '올바른 생년월일 6자리(예: 960211)를 입력해주세요.';
const ERROR_MSG_NOT_IN_ROSTER = '출석부에 등록되어있지 않은 정보입니다.';
const ERROR_MSG_DEVICE_DUPLICATE = '이미 이 기기에서 출석 등록이 완료되었습니다.';
const ERROR_MSG_PARTICIPANT_DUPLICATE = '이미 출석 처리가 완료된 참가자입니다.';
const ERROR_MSG_GPS_FAILED = '위치 정보를 확인할 수 없습니다. 스마트폰의 위치(GPS) 권한을 허용해주세요.';
const ERROR_MSG_INVALID_MANAGER_CODE = '담당자 확인 코드가 일치하지 않습니다.';
const ERROR_MSG_INVALID_QR_ACCESS = '잘못된 접근입니다. 현장에 비치된 QR코드를 직접 스캔해 주세요.';
const ERROR_MSG_SESSION_EXPIRED = '인증 시간이 만료되었습니다. QR코드를 다시 스캔해 주세요.';
const ERROR_MSG_BEFORE_CLASS = '수업 시작 전입니다.';
const ERROR_MSG_AFTER_CLASS = '수업이 종료되었습니다.';
const MANUAL_CONFIRM_NOTE = '담당자 수동확인';

let currentProgram = null;
let currentDeviceId = '';
let currentDeviceFingerprint = '';
let currentAttendanceDate = '';
let activeProgramCode = '';
let qrScannedAt = 0;
let manualModalTriggerSource = 'form'; // 'form' | 'already'
let approvedManualCode = ''; // 담당자 확인 코드 사전 승인 상태

// ============================================================================
// QR 세션 초기화 및 주소창 URL 즉시 변조 (외부 링크 공유 방지)
// ============================================================================

function generateInvalidTokenSuffix(length = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
    const bytes = new Uint32Array(length);
    window.crypto.getRandomValues(bytes);
    for (let i = 0; i < length; i++) {
      result += chars[bytes[i] % chars.length];
    }
    return result;
  }
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function clearQrAccessSession() {
  activeProgramCode = '';
  qrScannedAt = 0;
  try {
    if (window.sessionStorage) {
      window.sessionStorage.removeItem(SESSION_KEY_QR_ACCESS);
    }
  } catch (err) {}
}

/**
 * 페이지 로드 직후 실행:
 * - 정상 code 파라미터로 진입 시 JS 변수 & sessionStorage에 code + 스캔 타임스탬프 기록 후
 *   window.history.replaceState로 주소창을 ?token=invalid_xxxxx로 즉시 덮어씀
 * - code 파라미터가 없으면 sessionStorage의 기존 정상 진입 기록만 확인 (공유 링크 차단)
 */
function initializeQrAccessSession() {
  const params = new URLSearchParams(window.location.search);
  const urlCode = (params.get('code') || '').trim();

  if (urlCode) {
    activeProgramCode = urlCode;
    qrScannedAt = Date.now();
    try {
      if (window.sessionStorage) {
        window.sessionStorage.setItem(
          SESSION_KEY_QR_ACCESS,
          JSON.stringify({ code: activeProgramCode, scannedAt: qrScannedAt })
        );
      }
    } catch (err) {}

    try {
      if (window.history && typeof window.history.replaceState === 'function') {
        const pathname = window.location.pathname || './index.html';
        const maskedUrl = `${pathname}?token=invalid_${generateInvalidTokenSuffix(10)}`;
        window.history.replaceState(null, '', maskedUrl);
      }
    } catch (err) {}

    return { valid: true, code: activeProgramCode, scannedAt: qrScannedAt };
  }

  // URL에 code가 없는 경우 (변조된 링크 공유 접속 등): sessionStorage에 정상 진입 기록이 있을 때만 허용
  try {
    if (window.sessionStorage) {
      const raw = window.sessionStorage.getItem(SESSION_KEY_QR_ACCESS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.code === 'string' && parsed.code.trim() && Number(parsed.scannedAt) > 0) {
          activeProgramCode = parsed.code.trim();
          qrScannedAt = Number(parsed.scannedAt);
          return { valid: true, code: activeProgramCode, scannedAt: qrScannedAt };
        }
      }
    }
  } catch (err) {}

  activeProgramCode = '';
  qrScannedAt = 0;
  return { valid: false, code: '', scannedAt: 0 };
}

// 스크립트 로드 즉시 주소창 URL 변조 및 세션 초기화 수행
const initialQrSession = initializeQrAccessSession();

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

  try {
    localStorage.setItem(STORAGE_KEY_DEVICE_ID, resolvedId);
  } catch (err) {}
  await idbSet(IDB_STORE_META, STORAGE_KEY_DEVICE_ID, resolvedId);

  return resolvedId;
}

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

  if (window.crypto && window.crypto.subtle && window.TextEncoder) {
    try {
      const encoded = new TextEncoder().encode(rawSignals);
      const digest = await window.crypto.subtle.digest('SHA-256', encoded);
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return `fp_${hex.slice(0, 32)}`;
    } catch (err) {}
  }

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

  const map = getLocalSubmittedMap();
  if (map[key]) return map[key];

  const idbRecord = await idbGet(IDB_STORE_SUBMITTED, key);
  if (idbRecord) {
    try {
      map[key] = idbRecord;
      localStorage.setItem(STORAGE_KEY_SUBMITTED_MAP, JSON.stringify(map));
    } catch (err) {}
    return idbRecord;
  }

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
// 날짜 / 위치(Haversine) / 생년월일 6자리 / 연령구분 / 유효성 검증 유틸리티
// ============================================================================

function parseBoolFlag(val) {
  if (typeof val === 'boolean') return val;
  const s = String(val || '').trim().toUpperCase();
  return s === 'Y' || s === 'TRUE' || s === '1' || s === 'YES';
}

const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

function parseProgramDates(raw) {
  let items = [];
  if (Array.isArray(raw)) {
    items = raw.map((v) => String(v || '').trim());
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    items = raw.split(/[,\r\n]+/).map((v) => v.trim());
  }
  const unique = Array.from(new Set(items.filter((v) => v.length > 0)));
  unique.sort();
  return unique;
}

/**
 * YYYY-MM-DD -> 간소화 날짜 표기 (예: 2026-11-06 -> 11/6(금))
 */
function formatCompactDateLabel(dateStr) {
  const match = String(dateStr || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(dateStr || '').trim();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const weekday = WEEKDAY_LABELS[new Date(year, month - 1, day).getDay()];
  return `${month}/${day}(${weekday})`;
}

/**
 * 접속 시점의 시스템 현지 날짜를 YYYY-MM-DD 형식으로 반환
 */
function getSystemLocalIsoDate(dateObj = new Date()) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 접속 시점의 시스템 현지 날짜를 YYYY/MM/DD 형식으로 반환
 */
function getSystemLocalAttendanceDate(dateObj = new Date()) {
  return getSystemLocalIsoDate(dateObj).replace(/-/g, '/');
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
  } catch (err) {}
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
 * 단일 시간 문자열(예: "14:00", "오후 2:30", "18시 30분")을 자정 기준 초(seconds)로 변환
 */
function parseSingleTimeToSeconds(token) {
  const str = String(token || '').trim();
  if (!str) return null;

  let period = '';
  let hour = NaN;
  let minute = 0;

  const colonMatch = str.match(/^(오전|오후)?\s*(\d{1,2})\s*:\s*(\d{2})$/);
  if (colonMatch) {
    period = colonMatch[1] || '';
    hour = parseInt(colonMatch[2], 10);
    minute = parseInt(colonMatch[3], 10);
  } else {
    const korMatch = str.match(/^(오전|오후)?\s*(\d{1,2})시(?:\s*(\d{1,2})분?)?$/);
    if (!korMatch) return null;
    period = korMatch[1] || '';
    hour = parseInt(korMatch[2], 10);
    minute = korMatch[3] ? parseInt(korMatch[3], 10) : 0;
  }

  if (isNaN(hour) || isNaN(minute) || minute < 0 || minute > 59) return null;

  if (period === '오전') {
    if (hour < 1 || hour > 12) return null;
    hour = hour === 12 ? 0 : hour;
  } else if (period === '오후') {
    if (hour < 1 || hour > 12) return null;
    hour = hour === 12 ? 12 : hour + 12;
  } else {
    if (hour < 0 || hour > 24 || (hour === 24 && minute > 0)) return null;
  }

  return hour * 3600 + minute * 60;
}

/**
 * 프로그램 시간 문자열(예: "14:00 ~ 16:00", "18:00-20:00", "오후 2:00 ~ 오후 4:00") 파싱
 */
function parseProgramTimeRange(timeStr) {
  const raw = String(timeStr || '').trim();
  if (!raw) return null;

  const parts = raw.split(/\s*(?:~|-|–|—)\s*/);
  if (parts.length !== 2) return null;

  const startSec = parseSingleTimeToSeconds(parts[0]);
  const endSec = parseSingleTimeToSeconds(parts[1]);
  if (startSec === null || endSec === null || endSec < startSec) return null;

  return { startSec, endSec };
}

function parseHmsToSeconds(hmsStr) {
  const match = String(hmsStr || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hh = parseInt(match[1], 10);
  const mm = parseInt(match[2], 10);
  const ss = match[3] ? parseInt(match[3], 10) : 0;
  return hh * 3600 + mm * 60 + ss;
}

/**
 * 출석 등록 가능 시간 검증 및 지각 자동 판정
 * - 등록 가능 시간: [수업 시작 30분 전] ~ [수업 종료 10분 후]
 *   - 수업 시작 30분 전 이전 => "수업 시작 전입니다." (차단)
 *   - 수업 종료 10분 후 이후 => "수업이 종료되었습니다." (차단)
 * - 출석 상태(attendanceStatus):
 *   - [수업 시작 시간 + 30분] 이상 (예: 18:00 수업일 때 18:30:00부터) => "지각"
 *   - 그 이전(정상 출석) => "" (빈칸)
 */
function evaluateClassAttendanceTime(programTimeStr, referenceHms) {
  const range = parseProgramTimeRange(programTimeStr);
  if (!range) {
    return { allowed: true, attendanceStatus: '' };
  }

  const hms = referenceHms || getKstDateTimeParts().regTime;
  const nowSec = parseHmsToSeconds(hms);
  if (nowSec === null) {
    return { allowed: true, attendanceStatus: '' };
  }

  const openSec = range.startSec - 30 * 60;
  const lateSec = range.startSec + 30 * 60;
  const closeSec = range.endSec + 10 * 60;

  if (nowSec < openSec) {
    return {
      allowed: false,
      status: 'before_class',
      message: ERROR_MSG_BEFORE_CLASS,
      attendanceStatus: '',
    };
  }

  if (nowSec > closeSec) {
    return {
      allowed: false,
      status: 'after_class',
      message: ERROR_MSG_AFTER_CLASS,
      attendanceStatus: '',
    };
  }

  return {
    allowed: true,
    attendanceStatus: nowSec >= lateSec ? '지각' : '',
  };
}

/**
 * 연도별 청년 연령 자동 계산 (하드코딩 금지)
 * - 등록 연도(currentYear) 기준 연 나이 19세~39세
 *   (currentYear - 39 이상 currentYear - 19 이하) => '청년', 그 외 => '청년외'
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
 * 하버사인(Haversine) 공식으로 두 GPS 좌표 간 직선거리(m) 계산
 */
function calculateHaversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // 지구 반지름 (미터)
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * 현재 GPS 좌표 조회 (enableHighAccuracy: true, timeout: 10000)
 */
function getCurrentGpsPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('geolocation_unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
      },
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
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
      let birthDate = String(entry.birthDate || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
        const parsed = parseBirthDate6(birthDate);
        if (parsed.valid) birthDate = parsed.iso;
      }
      return {
        name,
        birthDate,
        gender: normalizeGender(entry.gender),
      };
    })
    .filter(Boolean);
}

/**
 * 두벌식 영문 타자 -> 한글 실시간 자동 조합 변환기
 * - 영문 키보드 상태에서 참가자명을 입력해도 즉시 한글로 자동 조합
 */
const ENG_TO_JAMO = {
  r: 'ㄱ', R: 'ㄲ', s: 'ㄴ', e: 'ㄷ', E: 'ㄸ', f: 'ㄹ', a: 'ㅁ',
  q: 'ㅂ', Q: 'ㅃ', t: 'ㅅ', T: 'ㅆ', d: 'ㅇ', w: 'ㅈ', W: 'ㅉ',
  c: 'ㅊ', z: 'ㅋ', x: 'ㅌ', v: 'ㅍ', g: 'ㅎ',
  k: 'ㅏ', o: 'ㅐ', i: 'ㅑ', O: 'ㅒ', j: 'ㅓ', p: 'ㅔ', u: 'ㅕ',
  P: 'ㅖ', h: 'ㅗ', y: 'ㅛ', n: 'ㅜ', b: 'ㅠ', m: 'ㅡ', l: 'ㅣ',
};
const CHOSEONG_LIST = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const JUNGSEONG_LIST = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
const JONGSEONG_LIST = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const COMPLEX_VOWEL_MAP = { 'ㅗㅏ':'ㅘ','ㅗㅐ':'ㅙ','ㅗㅣ':'ㅚ','ㅜㅓ':'ㅝ','ㅜㅔ':'ㅞ','ㅜㅣ':'ㅟ','ㅡㅣ':'ㅢ' };
const SPLIT_VOWEL_MAP = { 'ㅘ':['ㅗ','ㅏ'],'ㅙ':['ㅗ','ㅐ'],'ㅚ':['ㅗ','ㅣ'],'ㅝ':['ㅜ','ㅓ'],'ㅞ':['ㅜ','ㅔ'],'ㅟ':['ㅜ','ㅣ'],'ㅢ':['ㅡ','ㅣ'] };
const COMPLEX_JONG_MAP = { 'ㄱㅅ':'ㄳ','ㄴㅈ':'ㄵ','ㄴㅎ':'ㄶ','ㄹㄱ':'ㄺ','ㄹㅁ':'ㄻ','ㄹㅂ':'ㄼ','ㄹㅅ':'ㄽ','ㄹㅌ':'ㄾ','ㄹㅍ':'ㄿ','ㄹㅎ':'ㅀ','ㅂㅅ':'ㅄ' };
const SPLIT_JONG_MAP = { 'ㄳ':['ㄱ','ㅅ'],'ㄵ':['ㄴ','ㅈ'],'ㄶ':['ㄴ','ㅎ'],'ㄺ':['ㄹ','ㄱ'],'ㄻ':['ㄹ','ㅁ'],'ㄼ':['ㄹ','ㅂ'],'ㄽ':['ㄹ','ㅅ'],'ㄾ':['ㄹ','ㅌ'],'ㄿ':['ㄹ','ㅍ'],'ㅀ':['ㄹ','ㅎ'],'ㅄ':['ㅂ','ㅅ'] };
const CHOSEONG_SET = new Set(CHOSEONG_LIST);
const JUNGSEONG_SET = new Set(JUNGSEONG_LIST);

function isVowelJamo(ch) {
  return JUNGSEONG_SET.has(ch);
}

function isConsonantJamo(ch) {
  return CHOSEONG_SET.has(ch);
}

function decomposeToJamoStream(text) {
  const stream = [];
  for (const ch of String(text || '')) {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const offset = code - 0xac00;
      const cho = Math.floor(offset / 588);
      const jung = Math.floor((offset % 588) / 28);
      const jong = offset % 28;
      stream.push(CHOSEONG_LIST[cho]);
      const v = JUNGSEONG_LIST[jung];
      if (SPLIT_VOWEL_MAP[v]) stream.push(...SPLIT_VOWEL_MAP[v]);
      else stream.push(v);
      if (jong > 0) {
        const j = JONGSEONG_LIST[jong];
        if (SPLIT_JONG_MAP[j]) stream.push(...SPLIT_JONG_MAP[j]);
        else stream.push(j);
      }
    } else if (ENG_TO_JAMO[ch]) {
      stream.push(ENG_TO_JAMO[ch]);
    } else if (ENG_TO_JAMO[ch.toLowerCase()]) {
      stream.push(ENG_TO_JAMO[ch.toLowerCase()]);
    } else if (SPLIT_VOWEL_MAP[ch]) {
      stream.push(...SPLIT_VOWEL_MAP[ch]);
    } else if (SPLIT_JONG_MAP[ch]) {
      stream.push(...SPLIT_JONG_MAP[ch]);
    } else {
      stream.push(ch);
    }
  }
  return stream;
}

function convertEngTypingToHangul(text) {
  const stream = decomposeToJamoStream(text);
  let out = '';
  let i = 0;

  while (i < stream.length) {
    const c = stream[i];
    if (isConsonantJamo(c) && i + 1 < stream.length && isVowelJamo(stream[i + 1])) {
      const choIdx = CHOSEONG_LIST.indexOf(c);
      i += 1;

      let vowel = stream[i];
      i += 1;
      if (i < stream.length && COMPLEX_VOWEL_MAP[vowel + stream[i]]) {
        vowel = COMPLEX_VOWEL_MAP[vowel + stream[i]];
        i += 1;
      }
      const jungIdx = JUNGSEONG_LIST.indexOf(vowel);

      let jongIdx = 0;
      if (i < stream.length && isConsonantJamo(stream[i])) {
        const cand1 = stream[i];
        const next1IsVowel = i + 1 < stream.length && isVowelJamo(stream[i + 1]);
        const j1Idx = JONGSEONG_LIST.indexOf(cand1);

        if (!next1IsVowel && j1Idx > 0) {
          if (i + 1 < stream.length && isConsonantJamo(stream[i + 1])) {
            const combined = COMPLEX_JONG_MAP[cand1 + stream[i + 1]];
            const next2IsVowel = i + 2 < stream.length && isVowelJamo(stream[i + 2]);
            if (combined && !next2IsVowel) {
              jongIdx = JONGSEONG_LIST.indexOf(combined);
              i += 2;
            } else {
              jongIdx = j1Idx;
              i += 1;
            }
          } else {
            jongIdx = j1Idx;
            i += 1;
          }
        }
      }

      out += String.fromCharCode(0xac00 + choIdx * 588 + jungIdx * 28 + jongIdx);
    } else if (isVowelJamo(c) && i + 1 < stream.length && COMPLEX_VOWEL_MAP[c + stream[i + 1]]) {
      out += COMPLEX_VOWEL_MAP[c + stream[i + 1]];
      i += 2;
    } else {
      out += c;
      i += 1;
    }
  }

  return out;
}

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

function normalizeProgramResponse(raw) {
  if (!raw) return null;
  const roster = normalizeRosterList(raw.roster || raw.preRegisteredList);
  const locationEnabled = parseBoolFlag(raw.locationEnabled);
  const hasManagerCode =
    typeof raw.hasManagerCode === 'boolean'
      ? raw.hasManagerCode
      : Boolean(String(raw.managerCode || '').trim());

  return {
    ...raw,
    roster,
    preRegisteredList: roster,
    isMultiSession: parseBoolFlag(raw.isMultiSession),
    locationEnabled,
    locationName: String(raw.locationName || '').trim(),
    latitude: raw.latitude !== undefined && raw.latitude !== '' ? Number(raw.latitude) : null,
    longitude: raw.longitude !== undefined && raw.longitude !== '' ? Number(raw.longitude) : null,
    allowedRadius: Number(raw.allowedRadius) || 300,
    hasManagerCode,
    managerCode: String(raw.managerCode || '').trim(),
  };
}

async function fetchProgramByCode(code, deviceCheck = {}) {
  if (IS_TEST_MODE) {
    const programs = getLocalPrograms();
    const found = programs.find((item) => item.code === code);
    return normalizeProgramResponse(found || null);
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
    return normalizeProgramResponse(result.data);
  }
  return null;
}

/**
 * 담당자 확인 코드 검증 (모달 사전 승인 / 기기 중복 화면 우회용)
 */
async function verifyProgramManagerCode(programCode, managerCode) {
  const inputCode = String(managerCode || '').trim();
  if (!inputCode) {
    return { ok: false, message: ERROR_MSG_INVALID_MANAGER_CODE };
  }

  if (IS_TEST_MODE) {
    const programs = getLocalPrograms();
    const program = programs.find((item) => item.code === programCode);
    if (!program) {
      return { ok: false, message: '유효하지 않은 프로그램입니다.' };
    }
    const savedCode = String(program.managerCode || '').trim() || '1234';
    if (inputCode !== savedCode) {
      return { ok: false, message: ERROR_MSG_INVALID_MANAGER_CODE };
    }
    return { ok: true };
  }

  if (!GAS_WEB_APP_URL) {
    throw new Error('GAS_WEB_APP_URL이 설정되지 않았습니다.');
  }

  const response = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    redirect: 'follow',
    body: JSON.stringify({
      action: 'verifyManagerCode',
      programCode,
      managerCode: inputCode,
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
    message: result.message || ERROR_MSG_INVALID_MANAGER_CODE,
  };
}

async function submitAttendanceRecord(payload) {
  if (IS_TEST_MODE) {
    const programs = getLocalPrograms();
    const rawProgram = programs.find((item) => item.code === payload.programCode);
    const program = normalizeProgramResponse(rawProgram);
    if (!program) {
      return {
        status: 'not_found',
        message: '유효하지 않은 프로그램입니다.',
      };
    }

    const isManual = Boolean(payload.manualOverride);

    // 0) 담당자 수동 출석 승인 시 확인 코드 검증
    if (isManual) {
      const providedCode = String(payload.managerCode || '').trim();
      const expectedCode = String(program.managerCode || '').trim() || '1234';
      if (!providedCode || providedCode !== expectedCode) {
        return {
          status: 'invalid_manager_code',
          message: ERROR_MSG_INVALID_MANAGER_CODE,
        };
      }
    }

    // 1) 프로그램 일자 검증 (다회차 날짜 제한 해제가 아닌 경우 선택된 프로그램 일자 중 오늘이 포함되어야 함)
    const todayIso = getSystemLocalIsoDate();
    const scheduledDates = parseProgramDates(
      Array.isArray(program.dates) && program.dates.length > 0 ? program.dates : program.date
    );
    if (!program.isMultiSession && scheduledDates.length > 0 && !scheduledDates.includes(todayIso)) {
      return {
        status: 'invalid_date',
        message: `출석 가능한 일자가 아닙니다. (프로그램 일자: ${scheduledDates.join(', ')})`,
      };
    }

    // 1-2) 출석 등록 가능 시간 검증 ([수업 시작 30분 전] ~ [수업 종료 10분 후]) 및 지각 자동 판정
    const kst = getKstDateTimeParts();
    const timeEval = evaluateClassAttendanceTime(program.time, kst.regTime);
    if (!isManual && !timeEval.allowed) {
      return {
        status: timeEval.status,
        message: timeEval.message,
      };
    }

    // 2) 위치 기반 출석 제한 검증 (수동 출석 승인 시 우회)
    if (program.locationEnabled && !isManual) {
      const targetLat = Number(program.latitude);
      const targetLng = Number(program.longitude);
      const userLat = Number(payload.userLat);
      const userLng = Number(payload.userLng);
      const radius = Number(program.allowedRadius) || 300;

      if (
        !Number.isFinite(userLat) ||
        !Number.isFinite(userLng) ||
        !Number.isFinite(targetLat) ||
        !Number.isFinite(targetLng)
      ) {
        return {
          status: 'gps_error',
          message: ERROR_MSG_GPS_FAILED,
        };
      }

      const distance = calculateHaversineDistanceMeters(targetLat, targetLng, userLat, userLng);
      if (distance > radius) {
        return {
          status: 'out_of_range',
          message: `지정된 프로그램 장소 인근(반경 ${radius}m 이내)에서만 출석 등록이 가능합니다.`,
        };
      }
    }

    // 3) 출석부 명단이 등록되어 있는 경우 이름 + 생년월일 + 성별 정확 일치 대조
    const rosterCheck = verifyRosterMatch(
      {
        name: payload.participantName,
        birthDate: payload.birthDate,
        gender: payload.gender,
      },
      program.roster
    );
    if (!rosterCheck.matched) {
      return {
        status: 'not_in_roster',
        message: ERROR_MSG_NOT_IN_ROSTER,
      };
    }

    const participants = getLocalParticipants();

    // 4) 같은 프로그램코드 + 출석일자 내 동일 기기 차단 (담당자 수동 출석 승인 시 우회)
    if (!isManual) {
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
    }

    // 5) 같은 프로그램코드 + 출석일자 내 동일 참가자(참가자명 + 생년월일) 중복 차단
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

    const ageGroup = calculateAgeGroup(payload.birthDate, kst.year);
    const note = isManual ? MANUAL_CONFIRM_NOTE : '';
    const attendanceStatus = timeEval.attendanceStatus;

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
      note,
      attendanceStatus,
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
  const invalidTitle = document.getElementById('invalidTitle');
  const invalidMessage = document.getElementById('invalidMessage');
  const alreadySubmittedSection = document.getElementById('alreadySubmittedSection');
  const alreadySummaryBox = document.getElementById('alreadySummaryBox');
  const alreadyProgramName = document.getElementById('alreadyProgramName');
  const alreadyAttendanceDate = document.getElementById('alreadyAttendanceDate');
  const alreadyManualWrap = document.getElementById('alreadyManualWrap');
  const openManualFromAlreadyBtn = document.getElementById('openManualFromAlreadyBtn');
  const formSection = document.getElementById('formSection');
  const manualModeBanner = document.getElementById('manualModeBanner');
  const completeSection = document.getElementById('completeSection');
  const testModeBadge = document.getElementById('testModeBadge');

  // 폼 필드
  const attendanceForm = document.getElementById('attendanceForm');
  const programNameInput = document.getElementById('programName');
  const programSchedule = document.getElementById('programSchedule');
  const programInstructor = document.getElementById('programInstructor');
  const programLocationDivider = document.getElementById('programLocationDivider');
  const programLocationInfo = document.getElementById('programLocationInfo');
  const programDatesList = document.getElementById('programDatesList');
  const attendanceDateInput = document.getElementById('attendanceDate');
  const participantNameInput = document.getElementById('participantName');
  const birthDateInput = document.getElementById('birthDateInput');
  const genderSegment = document.getElementById('genderSegment');
  const genderValueInput = document.getElementById('genderValue');
  const submitBtn = document.getElementById('submitBtn');
  const formManualWrap = document.getElementById('formManualWrap');
  const openManualModalBtn = document.getElementById('openManualModalBtn');

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

  // 담당자 수동 출석 확인 모달 요소
  const manualVerifyModal = document.getElementById('manualVerifyModal');
  const manualVerifyForm = document.getElementById('manualVerifyForm');
  const manualCodeInput = document.getElementById('manualCodeInput');
  const manualCodeError = document.getElementById('manualCodeError');
  const closeManualModalBtn = document.getElementById('closeManualModalBtn');
  const cancelManualBtn = document.getElementById('cancelManualBtn');
  const confirmManualBtn = document.getElementById('confirmManualBtn');

  if (IS_TEST_MODE && testModeBadge) {
    testModeBadge.classList.remove('hidden');
  }

  // --------------------------------------------------------------------------
  // 1. 생년월일 6자리 숫자 전용 입력 처리 (예: 960211)
  // --------------------------------------------------------------------------
  birthDateInput.addEventListener('input', () => {
    const digitsOnly = birthDateInput.value.replace(/\D/g, '').slice(0, 6);
    if (birthDateInput.value !== digitsOnly) {
      birthDateInput.value = digitsOnly;
    }
    clearFieldError(birthError, [birthDateInput]);
    hideFormAlert();
  });

  birthDateInput.addEventListener('blur', () => {
    if (!birthDateInput.value.trim()) return;
    const check = parseBirthDate6(birthDateInput.value);
    if (!check.valid) {
      showFieldError(birthError, check.message, [birthDateInput]);
    }
  });

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

  let isComposingParticipantName = false;
  participantNameInput.addEventListener('compositionstart', () => {
    isComposingParticipantName = true;
  });
  participantNameInput.addEventListener('compositionend', () => {
    isComposingParticipantName = false;
  });

  participantNameInput.addEventListener('input', (e) => {
    if (
      !isComposingParticipantName &&
      !(e && e.isComposing) &&
      /[a-zA-Z]/.test(participantNameInput.value)
    ) {
      const converted = convertEngTypingToHangul(participantNameInput.value);
      if (converted !== participantNameInput.value) {
        participantNameInput.value = converted;
      }
    }
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

  function showInvalidScreen(customMessage, customTitle) {
    hideAllSections();
    if (customTitle && invalidTitle) {
      invalidTitle.textContent = customTitle;
    }
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

    alreadyManualWrap.classList.remove('hidden');
    alreadySubmittedSection.classList.remove('hidden');
  }

  function showFormScreen(program, attendanceDate) {
    currentProgram = program;
    currentAttendanceDate = attendanceDate;

    programNameInput.value = program.name;
    programSchedule.textContent = program.time || '';
    programInstructor.textContent = `강사: ${program.instructor}`;

    // 날짜를 11/6(금) 11/13(금) 형태의 간소화 타원형 배지로 표시
    const dates = parseProgramDates(
      Array.isArray(program.dates) && program.dates.length > 0 ? program.dates : program.date
    );
    const todayIso = getSystemLocalIsoDate();
    if (programDatesList) {
      programDatesList.innerHTML = '';
      if (dates.length > 0) {
        dates.forEach((d) => {
          const pill = document.createElement('span');
          pill.className = 'session-date-pill';
          if (d === todayIso) {
            pill.classList.add('is-today');
          }
          pill.textContent = formatCompactDateLabel(d);
          programDatesList.appendChild(pill);
        });
        programDatesList.classList.remove('hidden');
      } else {
        programDatesList.classList.add('hidden');
      }
    }

    // 장소명만 표시 (허용 반경 거리 텍스트/배지 비노출)
    if (program.locationName) {
      programLocationInfo.textContent = `장소: ${program.locationName}`;
      programLocationDivider.classList.remove('hidden');
      programLocationInfo.classList.remove('hidden');
    } else {
      programLocationDivider.classList.add('hidden');
      programLocationInfo.classList.add('hidden');
    }

    // 담당자 수동 출석 확인 버튼 상시 노출
    formManualWrap.classList.remove('hidden');

    if (approvedManualCode) {
      manualModeBanner.classList.remove('hidden');
    } else {
      manualModeBanner.classList.add('hidden');
    }

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
  // 5. 폼 입력값 검증 헬퍼
  // --------------------------------------------------------------------------
  function validateAttendanceFormInputs({ focusInvalid = true } = {}) {
    hideFormAlert();
    clearFieldError(nameError, [participantNameInput]);
    clearFieldError(birthError, [birthDateInput]);
    clearFieldError(genderError, [genderSegment]);
    clearFieldError(consentError);

    let firstInvalidEl = null;

    // 1) 참가자명 검증
    const nameCheck = validateParticipantName(participantNameInput.value);
    if (!nameCheck.valid) {
      showFieldError(nameError, nameCheck.message, [participantNameInput]);
      firstInvalidEl = firstInvalidEl || participantNameInput;
    }

    // 2) 생년월일 6자리 검증 및 YYYY-MM-DD 변환
    const birthCheck = parseBirthDate6(birthDateInput.value);
    if (!birthCheck.valid) {
      showFieldError(birthError, birthCheck.message, [birthDateInput]);
      firstInvalidEl = firstInvalidEl || birthDateInput;
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
      if (focusInvalid) firstInvalidEl.focus();
      return { valid: false };
    }

    return {
      valid: true,
      cleanedName: nameCheck.cleanedName,
      birthDate: birthCheck.iso,
      gender: genderVal,
      privacyConsent: consentVal,
    };
  }

  // --------------------------------------------------------------------------
  // 6. 담당자 수동 출석 확인 모달 제어
  // --------------------------------------------------------------------------
  function openManualModal(source = 'form') {
    manualModalTriggerSource = source;
    manualCodeInput.value = '';
    clearFieldError(manualCodeError, [manualCodeInput]);
    manualVerifyModal.classList.remove('hidden');
    manualCodeInput.focus();
  }

  function closeManualModal() {
    manualVerifyModal.classList.add('hidden');
    manualCodeInput.value = '';
    clearFieldError(manualCodeError, [manualCodeInput]);
  }

  openManualModalBtn.addEventListener('click', () => openManualModal('form'));
  openManualFromAlreadyBtn.addEventListener('click', () => openManualModal('already'));
  closeManualModalBtn.addEventListener('click', closeManualModal);
  cancelManualBtn.addEventListener('click', closeManualModal);

  manualVerifyModal.addEventListener('click', (e) => {
    if (e.target === manualVerifyModal) {
      closeManualModal();
    }
  });

  manualCodeInput.addEventListener('input', () => {
    clearFieldError(manualCodeError, [manualCodeInput]);
  });

  manualVerifyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentProgram) return;

    const enteredCode = manualCodeInput.value.trim();
    if (!enteredCode) {
      showFieldError(manualCodeError, '담당자 확인 코드를 입력해주세요.', [manualCodeInput]);
      manualCodeInput.focus();
      return;
    }

    confirmManualBtn.disabled = true;
    confirmManualBtn.textContent = '확인 중...';

    try {
      // 케이스 1: 기출석 안내 화면에서 수동 확인 진입 -> 코드 검증 후 폼 열기
      if (manualModalTriggerSource === 'already') {
        const verify = await verifyProgramManagerCode(currentProgram.code, enteredCode);
        if (!verify.ok) {
          showFieldError(manualCodeError, verify.message || ERROR_MSG_INVALID_MANAGER_CODE, [
            manualCodeInput,
          ]);
          manualCodeInput.focus();
          return;
        }
        approvedManualCode = enteredCode;
        closeManualModal();
        showFormScreen(currentProgram, currentAttendanceDate || getSystemLocalAttendanceDate());
        participantNameInput.focus();
        return;
      }

      // 케이스 2: 폼 화면에서 수동 확인 진입
      const formCheck = validateAttendanceFormInputs({ focusInvalid: false });

      // 아직 폼 입력이 덜 된 경우: 코드만 먼저 검증하고 수동 모드 활성화 후 폼으로 포커스
      if (!formCheck.valid) {
        const verify = await verifyProgramManagerCode(currentProgram.code, enteredCode);
        if (!verify.ok) {
          showFieldError(manualCodeError, verify.message || ERROR_MSG_INVALID_MANAGER_CODE, [
            manualCodeInput,
          ]);
          manualCodeInput.focus();
          return;
        }
        approvedManualCode = enteredCode;
        closeManualModal();
        manualModeBanner.classList.remove('hidden');
        validateAttendanceFormInputs({ focusInvalid: true });
        return;
      }

      // 폼 입력이 완료된 경우: 즉시 담당자 수동 출석 승인 제출 (GPS 및 기기 중복 제한 우회)
      const attendanceDate = attendanceDateInput.value || getSystemLocalAttendanceDate();

      // 로컬/출석부 1차 대조
      const roster = normalizeRosterList(
        currentProgram.roster || currentProgram.preRegisteredList
      );
      if (roster.length > 0) {
        const rosterCheck = verifyRosterMatch(
          {
            name: formCheck.cleanedName,
            birthDate: formCheck.birthDate,
            gender: formCheck.gender,
          },
          roster
        );
        if (!rosterCheck.matched) {
          closeManualModal();
          showFormAlert(ERROR_MSG_NOT_IN_ROSTER);
          return;
        }
      }

      const result = await submitAttendanceRecord({
        programCode: currentProgram.code,
        programName: currentProgram.name,
        attendanceDate,
        participantName: formCheck.cleanedName,
        birthDate: formCheck.birthDate,
        gender: formCheck.gender,
        privacyConsent: formCheck.privacyConsent,
        deviceId: currentDeviceId,
        deviceFingerprint: currentDeviceFingerprint,
        manualOverride: true,
        managerCode: enteredCode,
      });

      if (result.status === 'invalid_manager_code') {
        showFieldError(manualCodeError, result.message || ERROR_MSG_INVALID_MANAGER_CODE, [
          manualCodeInput,
        ]);
        manualCodeInput.focus();
        return;
      }

      if (result.status === 'success') {
        closeManualModal();
        approvedManualCode = '';
        await markDeviceSubmittedLocally(currentProgram.code, attendanceDate, {
          programName: currentProgram.name,
        });
        showCompleteScreen({
          programName: currentProgram.name,
          attendanceDate,
          participantName: formCheck.cleanedName,
        });
        return;
      }

      closeManualModal();
      showFormAlert(result.message || '수동 출석 처리 중 오류가 발생했습니다.');
    } catch (err) {
      showFieldError(
        manualCodeError,
        '서버와 통신하는 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
        [manualCodeInput]
      );
    } finally {
      confirmManualBtn.disabled = false;
      confirmManualBtn.textContent = '수동 출석 승인';
    }
  });

  // --------------------------------------------------------------------------
  // 7. 초기 진입: QR 세션 확인 -> 기기 식별자 생성 -> 프로그램 조회 -> 일자/다회차 검증 -> 기출석 확인
  // --------------------------------------------------------------------------
  async function initPage() {
    const code = activeProgramCode;

    if (!code) {
      showInvalidScreen(ERROR_MSG_INVALID_QR_ACCESS);
      return;
    }

    const todayIso = getSystemLocalIsoDate();
    const attendanceDate = getSystemLocalAttendanceDate();
    currentAttendanceDate = attendanceDate;

    try {
      const [deviceId, deviceFingerprint] = await Promise.all([
        ensurePersistentDeviceId(),
        generateDeviceFingerprint(),
      ]);
      currentDeviceId = deviceId;
      currentDeviceFingerprint = deviceFingerprint;

      const program = await fetchProgramByCode(code, {
        deviceId,
        deviceFingerprint,
        attendanceDate,
      });

      if (!program) {
        clearQrAccessSession();
        showInvalidScreen(ERROR_MSG_INVALID_QR_ACCESS);
        return;
      }

      currentProgram = program;

      // 프로그램 일자 유효성 검증 (다회차 날짜 제한 해제가 아닌 경우 선택된 일자 중 오늘이 포함되어야 함)
      const scheduledDates = parseProgramDates(
        Array.isArray(program.dates) && program.dates.length > 0 ? program.dates : program.date
      );
      if (!program.isMultiSession && scheduledDates.length > 0 && !scheduledDates.includes(todayIso)) {
        showInvalidScreen(
          `출석 가능한 일자가 아닙니다. (프로그램 일자: ${scheduledDates.join(', ')})`,
          '출석 가능한 일자가 아닙니다'
        );
        return;
      }

      // 동일 기기 기출석 여부 확인
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
  // 8. 본인 출석 등록 제출 처리 (QR 3분 만료 + 수업 시간 검증 + GPS 반경 검증)
  // --------------------------------------------------------------------------
  attendanceForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentProgram) return;

    const isManualApproved = Boolean(approvedManualCode);

    // 0) QR 스캔 후 3분 인증 만료 검증 (수동 출석 승인 모드 제외)
    if (!isManualApproved && (!qrScannedAt || Date.now() - qrScannedAt >= QR_SESSION_TTL_MS)) {
      showFormAlert(ERROR_MSG_SESSION_EXPIRED);
      return;
    }

    // 1) 출석 등록 가능 시간 검증: [수업 시작 30분 전] ~ [수업 종료 10분 후] (수동 출석 승인 모드 제외)
    if (!isManualApproved) {
      const timeCheck = evaluateClassAttendanceTime(currentProgram.time);
      if (!timeCheck.allowed) {
        showFormAlert(timeCheck.message);
        return;
      }
    }

    const formCheck = validateAttendanceFormInputs({ focusInvalid: true });
    if (!formCheck.valid) return;

    const attendanceDate = attendanceDateInput.value || getSystemLocalAttendanceDate();

    // 출석부 명단 1차 대조 (로컬 테스트 모드 또는 명단이 내려온 경우)
    const roster = normalizeRosterList(
      currentProgram.roster || currentProgram.preRegisteredList
    );
    if (roster.length > 0) {
      const rosterCheck = verifyRosterMatch(
        {
          name: formCheck.cleanedName,
          birthDate: formCheck.birthDate,
          gender: formCheck.gender,
        },
        roster
      );
      if (!rosterCheck.matched) {
        showFormAlert(ERROR_MSG_NOT_IN_ROSTER);
        return;
      }
    }

    let userLat = null;
    let userLng = null;

    submitBtn.disabled = true;

    try {
      // 위치 기반 출석 제한이 켜져 있고 수동 승인 모드가 아닌 경우 GPS 확인
      if (currentProgram.locationEnabled && !isManualApproved) {
        submitBtn.textContent = '현재 위치(GPS) 확인 중...';
        try {
          const pos = await getCurrentGpsPosition();
          userLat = pos.latitude;
          userLng = pos.longitude;
        } catch (gpsErr) {
          showFormAlert(ERROR_MSG_GPS_FAILED);
          return;
        }

        const targetLat = Number(currentProgram.latitude);
        const targetLng = Number(currentProgram.longitude);
        const allowedRadius = Number(currentProgram.allowedRadius) || 300;

        if (Number.isFinite(targetLat) && Number.isFinite(targetLng)) {
          const distance = calculateHaversineDistanceMeters(
            targetLat,
            targetLng,
            userLat,
            userLng
          );
          if (distance > allowedRadius) {
            showFormAlert(
              `지정된 프로그램 장소 인근(반경 ${allowedRadius}m 이내)에서만 출석 등록이 가능합니다.`
            );
            return;
          }
        }
      }

      submitBtn.textContent = '출석 등록 중...';

      const result = await submitAttendanceRecord({
        programCode: currentProgram.code,
        programName: currentProgram.name,
        attendanceDate,
        participantName: formCheck.cleanedName,
        birthDate: formCheck.birthDate,
        gender: formCheck.gender,
        privacyConsent: formCheck.privacyConsent,
        deviceId: currentDeviceId,
        deviceFingerprint: currentDeviceFingerprint,
        userLat,
        userLng,
        manualOverride: isManualApproved,
        managerCode: isManualApproved ? approvedManualCode : '',
      });

      if (result.status === 'success') {
        approvedManualCode = '';
        await markDeviceSubmittedLocally(currentProgram.code, attendanceDate, {
          programName: currentProgram.name,
        });
        showCompleteScreen({
          programName: currentProgram.name,
          attendanceDate,
          participantName: formCheck.cleanedName,
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
