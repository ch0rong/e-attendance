/**
 * 찾아가는 청년센터 - 관리자 페이지 로직 (admin.js)
 */

// ============================================================================
// 설정 (config.js에서 주입 — GitHub 공개 저장소에는 실제 URL/비밀번호를 포함하지 않음)
// ============================================================================
const APP_CONFIG = window.APP_CONFIG || {};

// true: 브라우저 localStorage를 사용하는 로컬 테스트 모드
// false: Google Apps Script(GAS) + Google Sheets 실연동 모드
const IS_TEST_MODE =
  typeof APP_CONFIG.IS_TEST_MODE === 'boolean' ? APP_CONFIG.IS_TEST_MODE : true;

// config.js(로컬) 또는 GitHub Actions Secrets(배포 시)에서 자동 주입되는 GAS 웹 앱 URL
const GAS_WEB_APP_URL = String(APP_CONFIG.GAS_WEB_APP_URL || '').trim();

// 로컬 테스트 모드(IS_TEST_MODE = true)에서만 사용하는 임시 비밀번호
// 실연동 모드(IS_TEST_MODE = false)에서는 Google Apps Script 스크립트 속성(ADMIN_PASSWORD)으로만 서버 검증합니다.
const LOCAL_TEST_PASSWORD = '1234';

// 인증 통과 후 메모리에만 유지하는 관리자 비밀번호 (localStorage/sessionStorage 미저장)
let adminSessionPassword = '';

const STORAGE_KEY_PROGRAMS = 'gjyouth_programs';
const CODE_PREFIX = 'gjyouth-';
const CODE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 6;
const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

const BIRTH_YEAR_MAX = 2012;
const BIRTH_YEAR_MIN = 1960;
const BIRTH_YEAR_DEFAULT = 2000;

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

const TIME_PERIODS = ['오전', '오후'];
const TIME_HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const TIME_MINUTES = ['00', '30'];

// 하루 48개 30분 슬롯 (시간순 정렬: 오전 12:00 ~ 오후 11:30)
const ALL_TIME_SLOTS = (() => {
  const slots = [];
  TIME_PERIODS.forEach((period) => {
    TIME_HOURS.forEach((hour) => {
      TIME_MINUTES.forEach((minute) => {
        const hour24 = (hour % 12) + (period === '오후' ? 12 : 0);
        slots.push({
          period,
          hour: String(hour),
          minute,
          minutes: hour24 * 60 + Number(minute),
        });
      });
    });
  });
  return slots;
})();

// 현재 로드된 프로그램 목록 캐시 및 수정 모드 상태
let cachedPrograms = [];
let editingProgramCode = null;

// ============================================================================
// 유틸리티 함수 (날짜, 시간, 사전명단, 코드 생성)
// ============================================================================

/**
 * 프로그램 일자 배열/문자열 파싱 -> 중복 제거 및 오름차순 정렬된 YYYY-MM-DD 배열 반환
 */
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
 * YYYY-MM-DD 날짜에 요일 표기 (full: '2026-11-24 (화)', short: '11/24 (화)')
 */
function formatDateWithWeekday(dateStr, short = false) {
  const match = String(dateStr || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(dateStr || '');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const weekday = WEEKDAY_LABELS[new Date(year, month - 1, day).getDay()];
  if (short) {
    return `${match[2]}/${match[3]} (${weekday})`;
  }
  return `${dateStr} (${weekday})`;
}

/**
 * 프로그램 일자 요약 문구 생성
 */
function formatProgramDatesSummary(program) {
  const dates = parseProgramDates(
    Array.isArray(program.dates) && program.dates.length > 0 ? program.dates : program.date
  );
  if (dates.length === 0) return String(program.date || '');
  if (dates.length === 1) {
    return formatDateWithWeekday(dates[0]);
  }
  return `총 ${dates.length}회기 (${dates.map((d) => formatDateWithWeekday(d, true)).join(', ')})`;
}

/**
 * 연/월/일 숫자를 YYYY-MM-DD 문자열로 변환
 */
function toIsoDate(year, monthIndexZeroBased, day) {
  const m = String(monthIndexZeroBased + 1).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

/**
 * 해당 연/월의 말일 계산 (윤년 반영)
 */
function getDaysInMonth(year, month) {
  if (!year || !month) return 31;
  return new Date(Number(year), Number(month), 0).getDate();
}

/**
 * 오전/오후 + 시(1~12) + 분(00/30) -> 자정 기준 분(0~1410) 변환
 */
function timePartsToMinutes(period, hour12, minute) {
  const h = Number(hour12);
  const m = Number(minute);
  let hour24 = h % 12;
  if (period === '오후') {
    hour24 += 12;
  }
  return hour24 * 60 + m;
}

/**
 * 자정 기준 분(0~1410) -> { period, hour, minute } 변환
 */
function minutesToTimeParts(totalMinutes) {
  const clamped = Math.max(0, Math.min(1410, totalMinutes));
  const hour24 = Math.floor(clamped / 60);
  const minute = String(clamped % 60).padStart(2, '0');
  const period = hour24 < 12 ? '오전' : '오후';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return {
    period,
    hour: String(hour12),
    minute: minute === '30' ? '30' : '00',
  };
}

/**
 * 시간 문자열 포맷 (예: "오전 9:00 ~ 오전 11:00")
 */
function formatTimeSlot(period, hour, minute) {
  return `${period} ${Number(hour)}:${String(minute).padStart(2, '0')}`;
}

/**
 * 저장된 시간 문자열 파싱 (예: "오전 9:00 ~ 오전 11:00" 또는 구형 "14:00 ~ 16:00")
 */
function parseTimeRangeString(timeStr) {
  const defaultRange = {
    start: { period: '오후', hour: '2', minute: '00' },
    end: { period: '오후', hour: '4', minute: '00' },
  };
  if (!timeStr || typeof timeStr !== 'string') return defaultRange;

  const parts = timeStr.split('~').map((s) => s.trim());
  if (parts.length !== 2) return defaultRange;

  function parseSingle(token) {
    // 1) "오전 9:00" / "오후 2:30" 형식
    const korMatch = token.match(/^(오전|오후)\s*(\d{1,2}):(\d{2})$/);
    if (korMatch) {
      const period = korMatch[1];
      const h = Number(korMatch[2]);
      const m = Number(korMatch[3]) >= 30 ? '30' : '00';
      if (h >= 1 && h <= 12) {
        return { period, hour: String(h), minute: m };
      }
    }
    // 2) 구형 24시간 "14:00" 형식
    const m24 = token.match(/^(\d{1,2}):(\d{2})$/);
    if (m24) {
      const h24 = Number(m24[1]);
      const m = Number(m24[2]) >= 30 ? 30 : 0;
      if (h24 >= 0 && h24 <= 23) {
        return minutesToTimeParts(h24 * 60 + m);
      }
    }
    return null;
  }

  const start = parseSingle(parts[0]);
  const end = parseSingle(parts[1]);
  if (!start || !end) return defaultRange;

  const startMin = timePartsToMinutes(start.period, start.hour, start.minute);
  const endMin = timePartsToMinutes(end.period, end.hour, end.minute);
  if (endMin <= startMin) return defaultRange;

  return { start, end };
}

/**
 * 사전 신청자 명단 정규화 (객체 배열 / JSON 문자열 / 구형 CSV 문자열 모두 지원)
 * @returns {Array<{ name: string, birthDate: string, gender: string }>}
 */
function normalizePreRegisteredList(raw) {
  let source = [];

  if (Array.isArray(raw)) {
    source = raw;
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          source = parsed;
        }
      } catch (err) {
        source = [];
      }
    } else {
      // 구형 쉼표/공백 구분 이름 문자열 호환
      source = trimmed
        .split(/[,\r\n\t\s]+/)
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => ({ name: n, birthDate: '', gender: '' }));
    }
  }

  const seen = new Set();
  const result = [];

  source.forEach((entry) => {
    if (typeof entry === 'string') {
      const name = entry.trim();
      if (!name) return;
      const key = `${name}||`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ name, birthDate: '', gender: '' });
      }
      return;
    }

    if (entry && typeof entry === 'object') {
      const name = String(entry.name || '').trim();
      const birthDate = String(entry.birthDate || '').trim();
      const gender = String(entry.gender || '').trim();
      if (!name) return;
      const key = `${name}|${birthDate}|${gender}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ name, birthDate, gender });
      }
    }
  });

  return result;
}

/**
 * 6자리 생년월일(YYMMDD) 파싱 및 유효성 검증 -> YYYY-MM-DD 변환
 */
function parseBirthDate6(rawValue) {
  const digits = String(rawValue || '').replace(/\D/g, '');
  if (!digits) {
    return { valid: false, message: '사전 신청자의 생년월일 6자리를 입력해주세요. (예: 950213)' };
  }
  if (digits.length !== 6) {
    return { valid: false, message: '생년월일은 숫자 6자리로 입력해주세요. (예: 950213)' };
  }

  const yy = parseInt(digits.slice(0, 2), 10);
  const mm = parseInt(digits.slice(2, 4), 10);
  const dd = parseInt(digits.slice(4, 6), 10);

  if (mm < 1 || mm > 12) {
    return { valid: false, message: '올바른 생년월일을 입력해주세요. (월은 01~12)' };
  }

  const now = new Date();
  const currentYY = now.getFullYear() % 100;
  const fullYear = yy <= currentYY ? 2000 + yy : 1900 + yy;

  const maxDays = new Date(fullYear, mm, 0).getDate();
  if (dd < 1 || dd > maxDays) {
    return { valid: false, message: '존재하지 않는 날짜입니다. 생년월일을 다시 확인해주세요.' };
  }

  const candidate = new Date(fullYear, mm - 1, dd);
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  if (candidate > todayEnd) {
    return { valid: false, message: '미래 날짜는 입력할 수 없습니다. 생년월일을 다시 확인해주세요.' };
  }

  const iso = `${fullYear}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  return { valid: true, digits, iso, fullYear };
}

/**
 * YYYY-MM-DD -> YYMMDD 6자리 표기 변환 (목록 표시용)
 */
function formatBirth6(birthDateStr) {
  const m = String(birthDateStr || '').trim().match(/^\d{2}(\d{2})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  return String(birthDateStr || '');
}

/**
 * 사전 신청자 개별 입력값 검증 (참가자 페이지와 동일한 실명 규칙 + 6자리 생년월일 + 중복 체크)
 */
function validateRosterEntry(entry, existingList) {
  const name = String(entry.name || '').trim();
  const rawBirth = String(entry.birthDate || '').trim();
  const gender = String(entry.gender || '').trim();

  if (!name) {
    return { valid: false, message: '사전 신청자 이름을 입력해주세요.' };
  }
  if (/\s/.test(name)) {
    return { valid: false, message: '이름은 띄어쓰기 없이 한글 2~5글자로 입력해주세요.' };
  }
  if (!/^[가-힣]{2,5}$/.test(name)) {
    return { valid: false, message: '이름은 한글 완성형 2~5글자만 입력할 수 있습니다.' };
  }
  if (/(.)\1{2,}/.test(name)) {
    return { valid: false, message: '동일한 글자를 3회 이상 반복한 이름은 등록할 수 없습니다.' };
  }
  if (NAME_BLACKLIST.includes(name)) {
    return { valid: false, message: '올바른 실명을 입력해주세요.' };
  }

  let normalizedBirth = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawBirth)) {
    normalizedBirth = rawBirth;
  } else {
    const birthCheck = parseBirthDate6(rawBirth);
    if (!birthCheck.valid) {
      return { valid: false, message: birthCheck.message };
    }
    normalizedBirth = birthCheck.iso;
  }

  if (gender !== '남성' && gender !== '여성') {
    return { valid: false, message: '사전 신청자의 성별을 선택해주세요.' };
  }

  const isDuplicate = (existingList || []).some(
    (item) => item.name === name && item.birthDate === normalizedBirth && item.gender === gender
  );
  if (isDuplicate) {
    return { valid: false, message: '이미 사전 신청자 명단에 등록된 참가자입니다.' };
  }

  return {
    valid: true,
    cleaned: { name, birthDate: normalizedBirth, gender },
  };
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
 * 현재 도메인/경로 기준 참가자 출석 등록 전용 URL 생성
 */
function buildAttendanceUrl(code) {
  const url = new URL('./index.html', window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('code', code);
  return url.toString();
}

/**
 * 한국 형식 현재 일시 문자열 (로컬 테스트 모드용)
 */
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
    return parsed.map((p) => ({
      ...p,
      dates: parseProgramDates(Array.isArray(p.dates) && p.dates.length > 0 ? p.dates : p.date),
      preRegisteredList: normalizePreRegisteredList(p.preRegisteredList),
    }));
  } catch (err) {
    return [];
  }
}

function saveLocalPrograms(programs) {
  localStorage.setItem(STORAGE_KEY_PROGRAMS, JSON.stringify(programs));
}

/**
 * 관리자 비밀번호 검증 (실연동 시 Google Apps Script 서버에서만 검증)
 */
async function verifyAdminPassword(password) {
  if (IS_TEST_MODE) {
    if (password === LOCAL_TEST_PASSWORD) {
      return { ok: true };
    }
    return { ok: false, message: '비밀번호가 일치하지 않습니다. (로컬 테스트 기본값: 1234)' };
  }

  if (!GAS_WEB_APP_URL) {
    return {
      ok: false,
      message: 'GAS_WEB_APP_URL이 설정되지 않았습니다. config.js 또는 GitHub Secrets 설정을 확인해주세요.',
    };
  }

  const response = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8',
    },
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
    throw new Error('GAS_WEB_APP_URL이 설정되지 않았습니다. config.js 또는 GitHub Secrets 설정을 확인해주세요.');
  }

  const response = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8',
    },
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
    ? result.data.map((p) => ({
        ...p,
        dates: parseProgramDates(Array.isArray(p.dates) && p.dates.length > 0 ? p.dates : p.date),
        preRegisteredList: normalizePreRegisteredList(p.preRegisteredList),
      }))
    : [];
}

async function saveNewProgram(programData) {
  const normalizedDates = parseProgramDates(programData.dates || programData.date);
  const dateString = normalizedDates.join(', ');
  const normalizedRoster = normalizePreRegisteredList(programData.preRegisteredList);

  if (IS_TEST_MODE) {
    const list = getLocalPrograms();
    const record = {
      createdAt: formatLocalDateTime(),
      code: programData.code,
      name: programData.name,
      date: dateString,
      dates: normalizedDates,
      time: programData.time,
      instructor: programData.instructor,
      preRegisteredList: normalizedRoster,
    };
    list.unshift(record);
    saveLocalPrograms(list);
    return record;
  }

  if (!GAS_WEB_APP_URL) {
    throw new Error('GAS_WEB_APP_URL이 설정되지 않았습니다. config.js 또는 GitHub Secrets 설정을 확인해주세요.');
  }

  const response = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8',
    },
    redirect: 'follow',
    body: JSON.stringify({
      action: 'createProgram',
      adminPassword: adminSessionPassword,
      code: programData.code,
      name: programData.name,
      date: dateString,
      dates: normalizedDates,
      time: programData.time,
      instructor: programData.instructor,
      preRegisteredList: normalizedRoster,
    }),
  });

  if (!response.ok) {
    throw new Error(`서버 응답 오류 (HTTP ${response.status})`);
  }

  const result = await response.json();
  if (result.status !== 'success') {
    throw new Error(result.message || '프로그램 생성에 실패했습니다.');
  }

  return result.data;
}

/**
 * 기존 프로그램 수정 (프로그램목록만 갱신, 기존 참가자명단 출석 기록은 변경하지 않음)
 */
async function updateExistingProgram(programData) {
  const normalizedDates = parseProgramDates(programData.dates || programData.date);
  const dateString = normalizedDates.join(', ');
  const normalizedRoster = normalizePreRegisteredList(programData.preRegisteredList);

  if (IS_TEST_MODE) {
    const list = getLocalPrograms();
    const idx = list.findIndex((item) => item.code === programData.code);
    if (idx === -1) {
      throw new Error('수정할 프로그램을 찾을 수 없습니다.');
    }

    const updated = {
      ...list[idx],
      name: programData.name,
      date: dateString,
      dates: normalizedDates,
      time: programData.time,
      instructor: programData.instructor,
      preRegisteredList: normalizedRoster,
    };
    list[idx] = updated;
    saveLocalPrograms(list);
    return updated;
  }

  if (!GAS_WEB_APP_URL) {
    throw new Error('GAS_WEB_APP_URL이 설정되지 않았습니다. config.js 또는 GitHub Secrets 설정을 확인해주세요.');
  }

  const response = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8',
    },
    redirect: 'follow',
    body: JSON.stringify({
      action: 'updateProgram',
      adminPassword: adminSessionPassword,
      code: programData.code,
      name: programData.name,
      date: dateString,
      dates: normalizedDates,
      time: programData.time,
      instructor: programData.instructor,
      preRegisteredList: normalizedRoster,
    }),
  });

  if (!response.ok) {
    throw new Error(`서버 응답 오류 (HTTP ${response.status})`);
  }

  const result = await response.json();
  if (result.status !== 'success') {
    throw new Error(result.message || '프로그램 수정에 실패했습니다.');
  }

  return result.data;
}

/**
 * 프로그램(링크) 삭제 (프로그램목록에서만 제거, 기존 참가자명단 출석 기록은 유지)
 */
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
    throw new Error('GAS_WEB_APP_URL이 설정되지 않았습니다. config.js 또는 GitHub Secrets 설정을 확인해주세요.');
  }

  const response = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8',
    },
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
// UI 렌더링 및 이벤트 바인딩
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  // 헤더 테스트 모드 배지
  const testModeBadge = document.getElementById('testModeBadge');
  if (IS_TEST_MODE && testModeBadge) {
    testModeBadge.classList.remove('hidden');
  }

  // 인증 요소
  const authSection = document.getElementById('authSection');
  const authForm = document.getElementById('authForm');
  const adminPasswordInput = document.getElementById('adminPasswordInput');
  const authError = document.getElementById('authError');
  const adminDashboard = document.getElementById('adminDashboard');

  // 폼 카드 / 수정 모드 요소
  const programFormCard = document.getElementById('programFormCard');
  const editModeBanner = document.getElementById('editModeBanner');
  const editModeCodeLabel = document.getElementById('editModeCodeLabel');
  const cancelEditBtn = document.getElementById('cancelEditBtn');
  const cancelEditBottomBtn = document.getElementById('cancelEditBottomBtn');
  const programFormTitle = document.getElementById('programFormTitle');
  const programFormSubtitle = document.getElementById('programFormSubtitle');

  // 생성/수정 폼 기본 요소
  const createProgramForm = document.getElementById('createProgramForm');
  const inputProgramName = document.getElementById('inputProgramName');
  const inputInstructor = document.getElementById('inputInstructor');
  const createAlert = document.getElementById('createAlert');
  const createProgramBtn = document.getElementById('createProgramBtn');

  // 다회기 복수 날짜 선택 달력 요소
  const selectedDateCountPill = document.getElementById('selectedDateCountPill');
  const calPrevMonthBtn = document.getElementById('calPrevMonthBtn');
  const calNextMonthBtn = document.getElementById('calNextMonthBtn');
  const calMonthLabel = document.getElementById('calMonthLabel');
  const calTodayBtn = document.getElementById('calTodayBtn');
  const calClearDatesBtn = document.getElementById('calClearDatesBtn');
  const calWeekdays = document.getElementById('calWeekdays');
  const calDaysGrid = document.getElementById('calDaysGrid');
  const selectedDatesWrap = document.getElementById('selectedDatesWrap');

  // 시간 드롭다운 요소
  const startPeriodSelect = document.getElementById('startPeriod');
  const startHourSelect = document.getElementById('startHour');
  const startMinuteSelect = document.getElementById('startMinute');
  const endPeriodSelect = document.getElementById('endPeriod');
  const endHourSelect = document.getElementById('endHour');
  const endMinuteSelect = document.getElementById('endMinute');
  const timePreviewText = document.getElementById('timePreviewText');

  // 사전 신청자 구조화 빌더 요소
  const rosterCountPill = document.getElementById('rosterCountPill');
  const rosterNameInput = document.getElementById('rosterNameInput');
  const rosterBirthInput = document.getElementById('rosterBirthInput');
  const rosterAddError = document.getElementById('rosterAddError');
  const addRosterBtn = document.getElementById('addRosterBtn');
  const rosterListContainer = document.getElementById('rosterListContainer');

  // 생성/수정 결과 카드 요소
  const createdResultSection = document.getElementById('createdResultSection');
  const resultTitleText = document.getElementById('resultTitleText');
  const resultCodeBadge = document.getElementById('resultCodeBadge');
  const resultProgramName = document.getElementById('resultProgramName');
  const resultDateTime = document.getElementById('resultDateTime');
  const resultInstructor = document.getElementById('resultInstructor');
  const resultMode = document.getElementById('resultMode');
  const resultUrlInput = document.getElementById('resultUrlInput');
  const copyResultUrlBtn = document.getElementById('copyResultUrlBtn');
  const openResultUrlLink = document.getElementById('openResultUrlLink');

  // 목록 요소
  const refreshListBtn = document.getElementById('refreshListBtn');
  const programListLoading = document.getElementById('programListLoading');
  const programListError = document.getElementById('programListError');
  const programListContainer = document.getElementById('programListContainer');

  // 페이지 진입 시 비밀번호 입력 포커스
  adminPasswordInput.focus();

  // --------------------------------------------------------------------------
  // 1. 관리자 비밀번호 인증 (실연동 시 Google Apps Script 서버 검증)
  // --------------------------------------------------------------------------
  const authSubmitBtn = authForm.querySelector('button[type="submit"]');

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const entered = adminPasswordInput.value;

    if (!entered) {
      authError.textContent = '비밀번호를 입력해주세요.';
      authError.classList.add('visible');
      adminPasswordInput.classList.add('is-invalid');
      adminPasswordInput.focus();
      return;
    }

    if (authSubmitBtn) {
      authSubmitBtn.disabled = true;
      authSubmitBtn.textContent = '인증 확인 중...';
    }

    try {
      const result = await verifyAdminPassword(entered);
      if (result.ok) {
        adminSessionPassword = entered;
        adminPasswordInput.value = '';
        authError.textContent = '';
        authError.classList.remove('visible');
        adminPasswordInput.classList.remove('is-invalid');

        authSection.classList.add('hidden');
        adminDashboard.classList.remove('hidden');

        loadAndRenderProgramList();
      } else {
        authError.textContent = result.message || '비밀번호가 일치하지 않습니다. 다시 확인해주세요.';
        authError.classList.add('visible');
        adminPasswordInput.classList.add('is-invalid');
        adminPasswordInput.select();
      }
    } catch (err) {
      authError.textContent = err.message || '서버 인증 중 오류가 발생했습니다.';
      authError.classList.add('visible');
    } finally {
      if (authSubmitBtn) {
        authSubmitBtn.disabled = false;
        authSubmitBtn.textContent = '확인';
      }
    }
  });

  adminPasswordInput.addEventListener('input', () => {
    authError.classList.remove('visible');
    adminPasswordInput.classList.remove('is-invalid');
  });

  // --------------------------------------------------------------------------
  // 2. 다회기 복수 날짜 선택 달력 (개별 클릭 + 요일별 일괄 토글)
  // --------------------------------------------------------------------------
  const todayObj = new Date();
  const todayIso = toIsoDate(todayObj.getFullYear(), todayObj.getMonth(), todayObj.getDate());
  let calViewYear = todayObj.getFullYear();
  let calViewMonth = todayObj.getMonth();
  const selectedDates = new Set();

  function getSortedSelectedDates() {
    return Array.from(selectedDates).sort();
  }

  function renderWeekdayHeaders() {
    calWeekdays.innerHTML = '';
    WEEKDAY_LABELS.forEach((label, weekdayIdx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'calendar-weekday-btn';
      if (weekdayIdx === 0) btn.classList.add('is-sun');
      if (weekdayIdx === 6) btn.classList.add('is-sat');
      btn.textContent = label;
      btn.title = `${calViewMonth + 1}월의 모든 ${label}요일 선택/해제`;
      btn.addEventListener('click', () => {
        toggleWeekdayInCurrentMonth(weekdayIdx);
      });
      calWeekdays.appendChild(btn);
    });
  }

  function toggleWeekdayInCurrentMonth(weekdayIdx) {
    const daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();
    const matchingDates = [];
    for (let day = 1; day <= daysInMonth; day++) {
      if (new Date(calViewYear, calViewMonth, day).getDay() === weekdayIdx) {
        matchingDates.push(toIsoDate(calViewYear, calViewMonth, day));
      }
    }

    const allSelected = matchingDates.every((d) => selectedDates.has(d));
    matchingDates.forEach((d) => {
      if (allSelected) {
        selectedDates.delete(d);
      } else {
        selectedDates.add(d);
      }
    });

    hideCreateError();
    renderCalendar();
  }

  function renderCalendar() {
    calMonthLabel.textContent = `${calViewYear}년 ${calViewMonth + 1}월`;
    renderWeekdayHeaders();

    const firstDayOfWeek = new Date(calViewYear, calViewMonth, 1).getDay();
    const daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();

    calDaysGrid.innerHTML = '';

    for (let i = 0; i < firstDayOfWeek; i++) {
      const emptyCell = document.createElement('span');
      emptyCell.className = 'calendar-day-empty';
      emptyCell.setAttribute('aria-hidden', 'true');
      calDaysGrid.appendChild(emptyCell);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const iso = toIsoDate(calViewYear, calViewMonth, day);
      const weekday = new Date(calViewYear, calViewMonth, day).getDay();
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'calendar-day-btn';
      btn.textContent = String(day);
      btn.dataset.date = iso;
      btn.setAttribute('aria-pressed', selectedDates.has(iso) ? 'true' : 'false');

      if (weekday === 0) btn.classList.add('is-sun');
      if (weekday === 6) btn.classList.add('is-sat');
      if (iso === todayIso) btn.classList.add('is-today');
      if (selectedDates.has(iso)) btn.classList.add('is-selected');

      btn.addEventListener('click', () => {
        if (selectedDates.has(iso)) {
          selectedDates.delete(iso);
        } else {
          selectedDates.add(iso);
        }
        hideCreateError();
        renderCalendar();
      });

      calDaysGrid.appendChild(btn);
    }

    renderSelectedDatesSummary();
  }

  function renderSelectedDatesSummary() {
    const sorted = getSortedSelectedDates();
    calClearDatesBtn.disabled = sorted.length === 0;

    if (sorted.length === 0) {
      selectedDateCountPill.textContent = '날짜 미선택';
      selectedDateCountPill.classList.remove('has-names');

      selectedDatesWrap.innerHTML = '';
      const emptyText = document.createElement('span');
      emptyText.className = 'selected-dates-empty';
      emptyText.textContent = '달력에서 프로그램 진행 날짜를 클릭해 선택하세요.';
      selectedDatesWrap.appendChild(emptyText);
      return;
    }

    selectedDateCountPill.textContent =
      sorted.length === 1 ? '1회기 선택' : `총 ${sorted.length}회기 선택`;
    selectedDateCountPill.classList.add('has-names');

    selectedDatesWrap.innerHTML = '';
    sorted.forEach((iso) => {
      const chip = document.createElement('span');
      chip.className = 'date-chip';

      const textSpan = document.createElement('span');
      textSpan.textContent = formatDateWithWeekday(iso);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'date-chip-remove';
      removeBtn.setAttribute('aria-label', `${iso} 선택 해제`);
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        selectedDates.delete(iso);
        renderCalendar();
      });

      chip.appendChild(textSpan);
      chip.appendChild(removeBtn);
      selectedDatesWrap.appendChild(chip);
    });
  }

  calPrevMonthBtn.addEventListener('click', () => {
    calViewMonth -= 1;
    if (calViewMonth < 0) {
      calViewMonth = 11;
      calViewYear -= 1;
    }
    renderCalendar();
  });

  calNextMonthBtn.addEventListener('click', () => {
    calViewMonth += 1;
    if (calViewMonth > 11) {
      calViewMonth = 0;
      calViewYear += 1;
    }
    renderCalendar();
  });

  calTodayBtn.addEventListener('click', () => {
    calViewYear = todayObj.getFullYear();
    calViewMonth = todayObj.getMonth();
    renderCalendar();
  });

  calClearDatesBtn.addEventListener('click', () => {
    selectedDates.clear();
    renderCalendar();
  });

  renderCalendar();

  // --------------------------------------------------------------------------
  // 3. 프로그램 시간 드롭다운 (오전/오후 + 1~12시 + 00/30분, 종료시간 동적 필터링)
  // --------------------------------------------------------------------------
  function populateStartHourOptions(preferredHour) {
    const prev = preferredHour || startHourSelect.value || '2';
    startHourSelect.innerHTML = '';
    TIME_HOURS.forEach((h) => {
      const opt = document.createElement('option');
      opt.value = String(h);
      opt.textContent = `${h}시`;
      startHourSelect.appendChild(opt);
    });
    startHourSelect.value = TIME_HOURS.map(String).includes(String(prev)) ? String(prev) : '2';
  }

  function populateStartMinuteOptions(preferredMinute) {
    const prev = preferredMinute || startMinuteSelect.value || '00';
    const isLastHourOfDay = startPeriodSelect.value === '오후' && startHourSelect.value === '11';
    // 오후 11:30은 하루의 마지막 슬롯이므로 시작시간에서 제외 (종료시간 11:30 보장)
    const allowedMinutes = isLastHourOfDay ? ['00'] : TIME_MINUTES;

    startMinuteSelect.innerHTML = '';
    allowedMinutes.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = `${m}분`;
      startMinuteSelect.appendChild(opt);
    });
    startMinuteSelect.value = allowedMinutes.includes(prev) ? prev : allowedMinutes[0];
  }

  function getStartMinutes() {
    return timePartsToMinutes(
      startPeriodSelect.value,
      startHourSelect.value,
      startMinuteSelect.value
    );
  }

  function getEndMinutes() {
    return timePartsToMinutes(
      endPeriodSelect.value,
      endHourSelect.value,
      endMinuteSelect.value
    );
  }

  function syncEndTimeOptions(preferredEnd = null) {
    const startMin = getStartMinutes();
    const validSlots = ALL_TIME_SLOTS.filter((slot) => slot.minutes > startMin);

    // 현재 선택값 또는 원하는 기본 종료값
    const prevPeriod = preferredEnd ? preferredEnd.period : endPeriodSelect.value;
    const prevHour = preferredEnd ? preferredEnd.hour : endHourSelect.value;
    const prevMinute = preferredEnd ? preferredEnd.minute : endMinuteSelect.value;

    const prevEndStillValid =
      prevPeriod &&
      prevHour &&
      prevMinute &&
      validSlots.some(
        (s) => s.period === prevPeriod && s.hour === String(prevHour) && s.minute === prevMinute
      );

    // 이전 종료시간이 더 이상 유효하지 않으면 시작시간 + 2시간(없으면 마지막 슬롯)을 추천 선택
    let targetSlot = null;
    if (prevEndStillValid) {
      targetSlot = { period: prevPeriod, hour: String(prevHour), minute: prevMinute };
    } else {
      const idealMin = startMin + 120;
      targetSlot =
        validSlots.find((s) => s.minutes >= idealMin) || validSlots[validSlots.length - 1];
    }

    // 1) 종료 오전/오후
    const validPeriods = Array.from(new Set(validSlots.map((s) => s.period)));
    endPeriodSelect.innerHTML = '';
    validPeriods.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      endPeriodSelect.appendChild(opt);
    });
    endPeriodSelect.value = validPeriods.includes(targetSlot.period)
      ? targetSlot.period
      : validPeriods[0];

    // 2) 종료 시 (선택된 종료 오전/오후에 해당하는 시작 이후 시간만 노출)
    syncEndHourAndMinuteOptions(targetSlot.hour, targetSlot.minute);
  }

  function syncEndHourAndMinuteOptions(preferredHour = null, preferredMinute = null) {
    const startMin = getStartMinutes();
    const selectedEndPeriod = endPeriodSelect.value;
    const periodSlots = ALL_TIME_SLOTS.filter(
      (slot) => slot.minutes > startMin && slot.period === selectedEndPeriod
    );

    const validHours = Array.from(new Set(periodSlots.map((s) => s.hour)));
    const targetHour = preferredHour || endHourSelect.value;

    endHourSelect.innerHTML = '';
    validHours.forEach((h) => {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = `${h}시`;
      endHourSelect.appendChild(opt);
    });
    endHourSelect.value = validHours.includes(String(targetHour))
      ? String(targetHour)
      : validHours[0];

    syncEndMinuteOptions(preferredMinute);
  }

  function syncEndMinuteOptions(preferredMinute = null) {
    const startMin = getStartMinutes();
    const selectedEndPeriod = endPeriodSelect.value;
    const selectedEndHour = endHourSelect.value;
    const validMinutes = ALL_TIME_SLOTS.filter(
      (slot) =>
        slot.minutes > startMin &&
        slot.period === selectedEndPeriod &&
        slot.hour === selectedEndHour
    ).map((s) => s.minute);

    const targetMinute = preferredMinute || endMinuteSelect.value;

    endMinuteSelect.innerHTML = '';
    validMinutes.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = `${m}분`;
      endMinuteSelect.appendChild(opt);
    });
    endMinuteSelect.value = validMinutes.includes(targetMinute) ? targetMinute : validMinutes[0];

    updateTimePreview();
  }

  function updateTimePreview() {
    const startText = formatTimeSlot(
      startPeriodSelect.value,
      startHourSelect.value,
      startMinuteSelect.value
    );
    const endText = formatTimeSlot(
      endPeriodSelect.value,
      endHourSelect.value,
      endMinuteSelect.value
    );
    timePreviewText.textContent = `${startText} ~ ${endText}`;
  }

  function getSelectedTimeRangeString() {
    const startText = formatTimeSlot(
      startPeriodSelect.value,
      startHourSelect.value,
      startMinuteSelect.value
    );
    const endText = formatTimeSlot(
      endPeriodSelect.value,
      endHourSelect.value,
      endMinuteSelect.value
    );
    return `${startText} ~ ${endText}`;
  }

  function setTimeDropdowns(range) {
    startPeriodSelect.value = range.start.period;
    populateStartHourOptions(range.start.hour);
    populateStartMinuteOptions(range.start.minute);
    syncEndTimeOptions(range.end);
  }

  startPeriodSelect.addEventListener('change', () => {
    populateStartMinuteOptions(startMinuteSelect.value);
    syncEndTimeOptions();
    hideCreateError();
  });

  startHourSelect.addEventListener('change', () => {
    populateStartMinuteOptions(startMinuteSelect.value);
    syncEndTimeOptions();
    hideCreateError();
  });

  startMinuteSelect.addEventListener('change', () => {
    syncEndTimeOptions();
    hideCreateError();
  });

  endPeriodSelect.addEventListener('change', () => {
    syncEndHourAndMinuteOptions();
    hideCreateError();
  });

  endHourSelect.addEventListener('change', () => {
    syncEndMinuteOptions();
    hideCreateError();
  });

  endMinuteSelect.addEventListener('change', () => {
    updateTimePreview();
    hideCreateError();
  });

  // 기본 시간 초기화: 오후 2:00 ~ 오후 4:00
  setTimeDropdowns({
    start: { period: '오후', hour: '2', minute: '00' },
    end: { period: '오후', hour: '4', minute: '00' },
  });

  // --------------------------------------------------------------------------
  // 4. 사전 신청자 구조화 빌더 (이름 + 생년월일 6자리 + 성별 + 추가 버튼)
  // --------------------------------------------------------------------------
  let rosterEntries = [];

  function resetRosterInputs() {
    rosterNameInput.value = '';
    rosterBirthInput.value = '';
    document.querySelectorAll('input[name="rosterGender"]').forEach((r) => {
      r.checked = false;
    });
    clearRosterAddError();
  }

  function showRosterAddError(message) {
    rosterAddError.textContent = message;
    rosterAddError.classList.add('visible');
  }

  function clearRosterAddError() {
    rosterAddError.textContent = '';
    rosterAddError.classList.remove('visible');
  }

  function renderRosterList() {
    if (rosterEntries.length > 0) {
      rosterCountPill.textContent = `사전명단 ${rosterEntries.length}명`;
      rosterCountPill.classList.add('has-names');
    } else {
      rosterCountPill.textContent = '현장자유등록';
      rosterCountPill.classList.remove('has-names');
    }

    rosterListContainer.innerHTML = '';

    if (rosterEntries.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'roster-list-empty';
      emptyEl.textContent = '등록된 사전 신청자가 없습니다. (비워두면 현장 자유 참여 모드로 운영됩니다)';
      rosterListContainer.appendChild(emptyEl);
      return;
    }

    rosterEntries.forEach((entry, idx) => {
      const row = document.createElement('div');
      row.className = 'roster-item';

      const info = document.createElement('div');
      info.className = 'roster-item-info';

      const numBadge = document.createElement('span');
      numBadge.className = 'roster-item-index';
      numBadge.textContent = String(idx + 1);

      const nameEl = document.createElement('span');
      nameEl.className = 'roster-item-name';
      nameEl.textContent = entry.name;

      const detailEl = document.createElement('span');
      detailEl.className = 'roster-item-detail';
      const detailParts = [];
      if (entry.birthDate) detailParts.push(formatBirth6(entry.birthDate));
      if (entry.gender) detailParts.push(entry.gender);
      detailEl.textContent = detailParts.length > 0 ? detailParts.join(' · ') : '이름만 등록됨(구버전)';

      info.appendChild(numBadge);
      info.appendChild(nameEl);
      info.appendChild(detailEl);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'roster-remove-btn';
      removeBtn.textContent = '삭제';
      removeBtn.addEventListener('click', () => {
        rosterEntries.splice(idx, 1);
        renderRosterList();
      });

      row.appendChild(info);
      row.appendChild(removeBtn);
      rosterListContainer.appendChild(row);
    });
  }

  function handleAddRosterParticipant() {
    clearRosterAddError();

    const genderRadio = document.querySelector('input[name="rosterGender"]:checked');
    const validation = validateRosterEntry(
      {
        name: rosterNameInput.value,
        birthDate: rosterBirthInput.value,
        gender: genderRadio ? genderRadio.value : '',
      },
      rosterEntries
    );

    if (!validation.valid) {
      showRosterAddError(validation.message);
      return;
    }

    rosterEntries.push(validation.cleaned);
    resetRosterInputs();
    renderRosterList();
    rosterNameInput.focus();
  }

  rosterBirthInput.addEventListener('input', () => {
    const digitsOnly = rosterBirthInput.value.replace(/\D/g, '').slice(0, 6);
    if (rosterBirthInput.value !== digitsOnly) {
      rosterBirthInput.value = digitsOnly;
    }
    clearRosterAddError();
  });

  rosterBirthInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddRosterParticipant();
    }
  });

  rosterNameInput.addEventListener('input', clearRosterAddError);
  rosterNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddRosterParticipant();
    }
  });
  document.querySelectorAll('input[name="rosterGender"]').forEach((r) => {
    r.addEventListener('change', clearRosterAddError);
  });
  addRosterBtn.addEventListener('click', handleAddRosterParticipant);

  renderRosterList();

  // --------------------------------------------------------------------------
  // 5. 프로그램 수정 모드 전환 / 취소
  // --------------------------------------------------------------------------
  function startEditProgram(program) {
    editingProgramCode = program.code;
    hideCreateError();

    editModeCodeLabel.textContent = program.code;
    editModeBanner.classList.remove('hidden');
    cancelEditBottomBtn.classList.remove('hidden');

    programFormTitle.textContent = '프로그램 수정';
    programFormSubtitle.textContent =
      '수정한 내용은 저장 이후 등록되는 출석부터 적용되며, 기존 출석 기록은 변경되지 않습니다.';
    createProgramBtn.textContent = '수정 내용 저장';

    // 1) 프로그램명 / 강사명
    inputProgramName.value = program.name || '';
    inputInstructor.value = program.instructor || '';

    // 2) 다회기 날짜 달력 세팅
    selectedDates.clear();
    const programDates = parseProgramDates(
      Array.isArray(program.dates) && program.dates.length > 0 ? program.dates : program.date
    );
    programDates.forEach((d) => selectedDates.add(d));
    if (programDates.length > 0) {
      const m = programDates[0].match(/^(\d{4})-(\d{2})-\d{2}$/);
      if (m) {
        calViewYear = Number(m[1]);
        calViewMonth = Number(m[2]) - 1;
      }
    }
    renderCalendar();

    // 3) 시간 드롭다운 세팅
    setTimeDropdowns(parseTimeRangeString(program.time));

    // 4) 사전 신청자 명단 세팅
    rosterEntries = normalizePreRegisteredList(program.preRegisteredList).map((item) => ({ ...item }));
    resetRosterInputs();
    renderRosterList();

    programFormCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function exitEditMode() {
    editingProgramCode = null;
    hideCreateError();

    editModeBanner.classList.add('hidden');
    cancelEditBottomBtn.classList.add('hidden');

    programFormTitle.textContent = '새 프로그램 생성';
    programFormSubtitle.textContent =
      '프로그램 정보를 입력하면 고유 코드가 자동 발급되고 참가자 출석 등록용 전용 링크가 생성됩니다.';
    createProgramBtn.textContent = '프로그램 생성 및 링크 발급';

    createProgramForm.reset();
    selectedDates.clear();
    calViewYear = todayObj.getFullYear();
    calViewMonth = todayObj.getMonth();
    renderCalendar();

    setTimeDropdowns({
      start: { period: '오후', hour: '2', minute: '00' },
      end: { period: '오후', hour: '4', minute: '00' },
    });

    rosterEntries = [];
    resetRosterInputs();
    renderRosterList();
  }

  cancelEditBtn.addEventListener('click', exitEditMode);
  cancelEditBottomBtn.addEventListener('click', exitEditMode);

  // --------------------------------------------------------------------------
  // 6. 프로그램 생성 / 수정 폼 제출
  // --------------------------------------------------------------------------
  function showCreateError(message) {
    createAlert.textContent = message;
    createAlert.classList.remove('hidden');
  }

  function hideCreateError() {
    createAlert.textContent = '';
    createAlert.classList.add('hidden');
  }

  createProgramForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideCreateError();

    const name = inputProgramName.value.trim();
    const dates = getSortedSelectedDates();
    const startMin = getStartMinutes();
    const endMin = getEndMinutes();
    const time = getSelectedTimeRangeString();
    const instructor = inputInstructor.value.trim();
    const preRegisteredList = rosterEntries.map((item) => ({ ...item }));

    if (!name) {
      showCreateError('프로그램명을 입력해주세요.');
      inputProgramName.focus();
      return;
    }
    if (dates.length === 0) {
      showCreateError('프로그램 일자를 달력에서 1개 이상 선택해주세요.');
      calDaysGrid.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (endMin <= startMin) {
      showCreateError('종료 시간은 시작 시간보다 이후여야 합니다.');
      endHourSelect.focus();
      return;
    }
    if (!instructor) {
      showCreateError('강사명을 입력해주세요.');
      inputInstructor.focus();
      return;
    }

    const isEditing = Boolean(editingProgramCode);
    createProgramBtn.disabled = true;
    createProgramBtn.textContent = isEditing ? '수정 내용 저장 중...' : '프로그램 생성 중...';

    try {
      let savedProgram;
      if (isEditing) {
        savedProgram = await updateExistingProgram({
          code: editingProgramCode,
          name,
          date: dates.join(', '),
          dates,
          time,
          instructor,
          preRegisteredList,
        });
      } else {
        const existingCodes = cachedPrograms.map((p) => p.code);
        const code = generateProgramCode(existingCodes);
        savedProgram = await saveNewProgram({
          code,
          name,
          date: dates.join(', '),
          dates,
          time,
          instructor,
          preRegisteredList,
        });
      }

      renderCreatedResult(savedProgram, isEditing);
      exitEditMode();

      await loadAndRenderProgramList();
      createdResultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      showCreateError(
        err.message || (isEditing ? '프로그램 수정 중 오류가 발생했습니다.' : '프로그램 생성 중 오류가 발생했습니다.')
      );
    } finally {
      createProgramBtn.disabled = false;
      createProgramBtn.textContent = editingProgramCode
        ? '수정 내용 저장'
        : '프로그램 생성 및 링크 발급';
    }
  });

  // --------------------------------------------------------------------------
  // 7. 생성 / 수정 완료 결과 카드 렌더링
  // --------------------------------------------------------------------------
  function renderCreatedResult(program, isUpdated = false) {
    const attendanceUrl = buildAttendanceUrl(program.code);
    const list = normalizePreRegisteredList(program.preRegisteredList);

    resultTitleText.textContent = isUpdated
      ? '프로그램 정보가 수정되었습니다'
      : '프로그램이 생성되었습니다';
    resultCodeBadge.textContent = program.code;
    resultProgramName.textContent = program.name;
    resultDateTime.textContent = `${formatProgramDatesSummary(program)} · ${program.time}`;
    resultInstructor.textContent = program.instructor;
    resultMode.textContent =
      list.length > 0
        ? `사전명단 ${list.length}명 (이름·생년월일·성별 일치 시 출석 가능)`
        : '현장자유등록 (누구나 등록 가능)';

    resultUrlInput.value = attendanceUrl;
    openResultUrlLink.href = attendanceUrl;

    copyResultUrlBtn.textContent = '링크 복사';
    copyResultUrlBtn.classList.remove('btn--copied');

    createdResultSection.classList.remove('hidden');
  }

  copyResultUrlBtn.addEventListener('click', () => {
    if (resultUrlInput.value) {
      copyTextWithFeedback(resultUrlInput.value, copyResultUrlBtn);
    }
  });

  resultUrlInput.addEventListener('click', () => {
    resultUrlInput.select();
  });

  // --------------------------------------------------------------------------
  // 8. 기존 프로그램 목록 불러오기 및 렌더링
  // --------------------------------------------------------------------------
  async function loadAndRenderProgramList() {
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

  function renderProgramList(programs) {
    programListContainer.innerHTML = '';

    if (!programs || programs.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'empty-state';
      emptyEl.textContent = '아직 생성된 프로그램이 없습니다. 위 폼에서 첫 프로그램을 생성해보세요.';
      programListContainer.appendChild(emptyEl);
      return;
    }

    programs.forEach((program) => {
      const list = normalizePreRegisteredList(program.preRegisteredList);
      const dates = parseProgramDates(
        Array.isArray(program.dates) && program.dates.length > 0 ? program.dates : program.date
      );
      const attendanceUrl = buildAttendanceUrl(program.code);

      const item = document.createElement('article');
      item.className = 'program-item';

      // 상단: 프로그램명 + 배지(다회기, 명단 제한 여부, 코드)
      const topRow = document.createElement('div');
      topRow.className = 'program-item-top';

      const nameEl = document.createElement('h3');
      nameEl.className = 'program-item-name';
      nameEl.textContent = program.name;

      const badgesEl = document.createElement('div');
      badgesEl.className = 'program-item-badges';

      if (dates.length > 1) {
        const sessionBadge = document.createElement('span');
        sessionBadge.className = 'badge badge--sessions';
        sessionBadge.textContent = `총 ${dates.length}회기`;
        badgesEl.appendChild(sessionBadge);
      }

      const modeBadge = document.createElement('span');
      if (list.length > 0) {
        modeBadge.className = 'badge badge--restricted';
        modeBadge.textContent = `사전명단 ${list.length}명`;
      } else {
        modeBadge.className = 'badge badge--open';
        modeBadge.textContent = '현장자유등록';
      }

      const codeBadge = document.createElement('span');
      codeBadge.className = 'badge badge--code';
      codeBadge.textContent = program.code;

      badgesEl.appendChild(modeBadge);
      badgesEl.appendChild(codeBadge);
      topRow.appendChild(nameEl);
      topRow.appendChild(badgesEl);

      // 중간: 일자, 시간, 강사명
      const metaEl = document.createElement('div');
      metaEl.className = 'program-item-meta';

      const dateSpan = document.createElement('span');
      dateSpan.textContent =
        dates.length === 1
          ? `일자: ${formatDateWithWeekday(dates[0])}`
          : `일자: ${dates.map((d) => formatDateWithWeekday(d, true)).join(', ')}`;

      const timeSpan = document.createElement('span');
      timeSpan.textContent = `시간: ${program.time}`;

      const instructorSpan = document.createElement('span');
      instructorSpan.textContent = `강사: ${program.instructor}`;

      metaEl.appendChild(dateSpan);
      metaEl.appendChild(timeSpan);
      metaEl.appendChild(instructorSpan);

      // 하단: 전용 링크 + [수정] / [링크 복사] / [삭제] 버튼
      const linkRow = document.createElement('div');
      linkRow.className = 'program-item-link-row';

      const linkAnchor = document.createElement('a');
      linkAnchor.className = 'program-item-url';
      linkAnchor.href = attendanceUrl;
      linkAnchor.target = '_blank';
      linkAnchor.rel = 'noopener noreferrer';
      linkAnchor.textContent = attendanceUrl;
      linkAnchor.title = attendanceUrl;

      const actionsEl = document.createElement('div');
      actionsEl.className = 'program-item-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn--secondary btn--sm';
      editBtn.textContent = '수정';
      editBtn.addEventListener('click', () => {
        startEditProgram(program);
      });

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn btn--secondary btn--sm';
      copyBtn.textContent = '링크 복사';
      copyBtn.addEventListener('click', () => {
        copyTextWithFeedback(attendanceUrl, copyBtn);
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn--danger-outline btn--sm';
      deleteBtn.textContent = '삭제';
      deleteBtn.addEventListener('click', async () => {
        const confirmed = window.confirm(
          `'${program.name}' (${program.code}) 프로그램 링크를 삭제하시겠습니까?\n\n삭제하면 해당 링크로 더 이상 출석 등록을 할 수 없으며, 기존 참가자 출석 기록은 그대로 유지됩니다.`
        );
        if (!confirmed) return;

        deleteBtn.disabled = true;
        deleteBtn.textContent = '삭제 중...';
        programListError.classList.add('hidden');

        try {
          await deleteProgramByCode(program.code);

          // 삭제한 프로그램이 수정 중이거나 결과 카드에 표시 중이면 정리
          if (editingProgramCode === program.code) {
            exitEditMode();
          }
          if (resultCodeBadge.textContent === program.code) {
            createdResultSection.classList.add('hidden');
          }

          await loadAndRenderProgramList();
        } catch (err) {
          programListError.textContent = err.message || '프로그램 삭제 중 오류가 발생했습니다.';
          programListError.classList.remove('hidden');
          deleteBtn.disabled = false;
          deleteBtn.textContent = '삭제';
        }
      });

      actionsEl.appendChild(editBtn);
      actionsEl.appendChild(copyBtn);
      actionsEl.appendChild(deleteBtn);

      linkRow.appendChild(linkAnchor);
      linkRow.appendChild(actionsEl);

      item.appendChild(topRow);
      item.appendChild(metaEl);
      item.appendChild(linkRow);
      programListContainer.appendChild(item);
    });
  }

  refreshListBtn.addEventListener('click', () => {
    loadAndRenderProgramList();
  });
});
