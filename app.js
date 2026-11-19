/**
 * 찾아가는 청년센터 - 참가자 출석 등록 페이지 로직 (app.js)
 */

// ============================================================================
// 설정 (config.js에서 주입 — GitHub 공개 저장소에는 실제 URL을 포함하지 않음)
// ============================================================================
const APP_CONFIG = window.APP_CONFIG || {};

// true: 브라우저 localStorage를 사용하는 로컬 테스트 모드
// false: Google Apps Script(GAS) + Google Sheets 실연동 모드
const IS_TEST_MODE =
  typeof APP_CONFIG.IS_TEST_MODE === 'boolean' ? APP_CONFIG.IS_TEST_MODE : true;

// config.js(로컬) 또는 GitHub Actions Secrets(배포 시)에서 자동 주입되는 GAS 웹 앱 URL
const GAS_WEB_APP_URL = String(APP_CONFIG.GAS_WEB_APP_URL || '').trim();

const STORAGE_KEY_PROGRAMS = 'gjyouth_programs';
const STORAGE_KEY_PARTICIPANTS = 'gjyouth_participants';

// 장난/테스트 단어 블랙리스트
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

const BIRTH_YEAR_MAX = 2012;
const BIRTH_YEAR_MIN = 1960;
const BIRTH_YEAR_DEFAULT = 2000;
const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

let currentProgram = null;

// ============================================================================
// 유틸리티 및 유효성 검증 함수
// ============================================================================

/**
 * 프로그램 일자 배열/문자열 파싱 -> 중복 제거 및 오름차순 정렬된 YYYY-MM-DD 배열
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
 * 시스템 현지 날짜를 YYYY/MM/DD 형식으로 반환
 */
function getLocalAttendanceDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}/${month}/${day}`;
}

/**
 * 시스템 현지 날짜를 YYYY-MM-DD 형식으로 반환 (다회기 오늘 일정 강조용)
 */
function getLocalIsoDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 연령구분 계산 (로컬 테스트 모드용 - GAS Code.gs와 동일 로직)
 * 출생연도 1987 ~ 2007 => '청년', 그 외 => '청년외'
 */
function calculateAgeGroup(birthDateStr) {
  const birthYear = parseInt(String(birthDateStr || '').slice(0, 4), 10);
  if (birthYear >= 1987 && birthYear <= 2007) {
    return '청년';
  }
  return '청년외';
}

/**
 * 사전 신청자 명단 정규화 (객체 배열 / JSON 문자열 / 구형 이름 배열 모두 지원)
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
        if (Array.isArray(parsed)) source = parsed;
      } catch (err) {
        source = [];
      }
    } else {
      source = trimmed
        .split(/[,\r\n\t\s]+/)
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => ({ name: n, birthDate: '', gender: '' }));
    }
  }

  return source
    .map((entry) => {
      if (typeof entry === 'string') {
        const name = entry.trim();
        return name ? { name, birthDate: '', gender: '' } : null;
      }
      if (entry && typeof entry === 'object') {
        const name = String(entry.name || '').trim();
        if (!name) return null;
        return {
          name,
          birthDate: String(entry.birthDate || '').trim(),
          gender: String(entry.gender || '').trim(),
        };
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * 사전 신청자 3개 정보(이름, 생년월일, 성별) 일치 여부 검증
 * @returns {{ matched: boolean, reason?: string, message?: string }}
 */
function verifyPreRegisteredMatch({ name, birthDate, gender }, preRegisteredList) {
  const list = normalizePreRegisteredList(preRegisteredList);
  if (list.length === 0) {
    return { matched: true };
  }

  const sameNameEntries = list.filter((entry) => entry.name === name);
  if (sameNameEntries.length === 0) {
    return {
      matched: false,
      reason: 'not_in_roster',
      message: '사전 신청 명단에 없는 이름입니다. 오타가 없는지 확인 후 다시 입력해주세요.',
    };
  }

  const normalizedBirth = normalizeBirthDateToIso(birthDate);
  const exactMatch = sameNameEntries.some((entry) => {
    const entryBirth = entry.birthDate ? normalizeBirthDateToIso(entry.birthDate) : '';
    const birthOk = !entryBirth || entryBirth === normalizedBirth;
    const genderOk = !entry.gender || entry.gender === gender;
    return birthOk && genderOk;
  });

  if (!exactMatch) {
    return {
      matched: false,
      reason: 'info_mismatch',
      message:
        '사전 신청 정보(이름, 생년월일, 성별)가 일치하지 않습니다. 입력한 내용을 다시 확인해주세요.',
    };
  }

  return { matched: true };
}

/**
 * 참가자명 엄격 유효성 검증 + 사전 신청자 명단(이름) 1차 대조
 * @returns {{ valid: boolean, cleanedName?: string, message?: string }}
 */
function validateParticipantName(rawValue, preRegisteredList) {
  const trimmed = String(rawValue || '').trim();

  if (!trimmed) {
    return {
      valid: false,
      message: '참가자명을 입력해주세요.',
    };
  }

  // 띄어쓰기 포함 차단
  if (/\s/.test(trimmed)) {
    return {
      valid: false,
      message: '띄어쓰기 없이 한글 실명(2~5글자)만 입력해주세요.',
    };
  }

  // 한글 완성형 음절 2~5글자만 허용 (영문, 숫자, 특수문자, 자음/모음 단독 입력 차단)
  if (!/^[가-힣]{2,5}$/.test(trimmed)) {
    return {
      valid: false,
      message: '한글 2~5글자 완성형 이름만 입력할 수 있습니다. (영문, 숫자, 특수문자, 초성/모음 불가)',
    };
  }

  // 동일 글자 3회 이상 연속 반복 차단 (예: 김김김)
  if (/(.)\1{2,}/.test(trimmed)) {
    return {
      valid: false,
      message: '동일한 글자를 3회 이상 반복하여 입력할 수 없습니다.',
    };
  }

  // 장난/테스트 단어 블랙리스트 차단
  if (NAME_BLACKLIST.includes(trimmed)) {
    return {
      valid: false,
      message: '올바른 실명을 입력해주세요.',
    };
  }

  // 사전 신청자 명단 1차 이름 대조
  const normalizedList = normalizePreRegisteredList(preRegisteredList);
  if (normalizedList.length > 0) {
    const hasName = normalizedList.some((entry) => entry.name === trimmed);
    if (!hasName) {
      return {
        valid: false,
        message: '사전 신청 명단에 없는 이름입니다. 오타가 없는지 확인 후 다시 입력해주세요.',
      };
    }
  }

  return {
    valid: true,
    cleanedName: trimmed,
  };
}

/**
 * 6자리 생년월일(YYMMDD) 파싱 및 유효성 검증 -> YYYY-MM-DD 변환
 */
function parseBirthDate6(rawValue) {
  const digits = String(rawValue || '').replace(/\D/g, '');
  if (!digits) {
    return { valid: false, message: '생년월일 6자리를 입력해주세요. (예: 950213)' };
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
 * 생년월일 문자열 정규화 (YYMMDD 또는 YYYY-MM-DD -> YYYY-MM-DD)
 */
function normalizeBirthDateToIso(rawValue) {
  const str = String(rawValue || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const parsed = parseBirthDate6(str);
  return parsed.valid ? parsed.iso : str;
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

async function fetchProgramByCode(code) {
  if (IS_TEST_MODE) {
    const programs = getLocalPrograms();
    const found = programs.find((item) => item.code === code);
    return found || null;
  }

  if (!GAS_WEB_APP_URL) {
    throw new Error('GAS_WEB_APP_URL이 설정되지 않았습니다.');
  }

  const requestUrl = new URL(GAS_WEB_APP_URL);
  requestUrl.searchParams.set('action', 'getProgram');
  requestUrl.searchParams.set('code', code);

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
    const participants = getLocalParticipants();

    // 중복 출석 체크: 프로그램코드 + 출석일자 + 참가자명 + 생년월일
    const isDuplicate = participants.some(
      (row) =>
        row.programCode === payload.programCode &&
        row.attendanceDate === payload.attendanceDate &&
        row.participantName === payload.participantName &&
        row.birthDate === payload.birthDate
    );

    if (isDuplicate) {
      return {
        status: 'duplicate',
        message: '이미 출석 처리가 완료된 참가자입니다.',
      };
    }

    // 오늘의 1등 판별: 동일 프로그램코드 + 출석일자 기준 기존 등록 건수 확인
    const sameDayCount = participants.filter(
      (row) =>
        row.programCode === payload.programCode &&
        row.attendanceDate === payload.attendanceDate
    ).length;
    const isFirstToday = sameDayCount === 0;
    const todayOrder = sameDayCount + 1;

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const regDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const regTime = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const record = {
      regDate,
      regTime,
      programCode: payload.programCode,
      programName: payload.programName,
      attendanceDate: payload.attendanceDate,
      participantName: payload.participantName,
      birthDate: payload.birthDate,
      ageGroup: calculateAgeGroup(payload.birthDate),
      gender: payload.gender,
      privacyConsent: payload.privacyConsent,
    };

    participants.push(record);
    saveLocalParticipants(participants);

    return {
      status: 'success',
      message: '출석이 완료되었습니다.',
      data: {
        ...record,
        isFirstToday,
        todayOrder,
      },
    };
  }

  if (!GAS_WEB_APP_URL) {
    throw new Error('GAS_WEB_APP_URL이 설정되지 않았습니다.');
  }

  const response = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    headers: {
      // CORS preflight 방지를 위해 text/plain 사용 (GAS doPost에서 JSON.parse로 처리)
      'Content-Type': 'text/plain;charset=utf-8',
    },
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
  const formSection = document.getElementById('formSection');
  const completeSection = document.getElementById('completeSection');
  const testModeBadge = document.getElementById('testModeBadge');

  // 폼 필드
  const attendanceForm = document.getElementById('attendanceForm');
  const programNameInput = document.getElementById('programName');
  const programSchedule = document.getElementById('programSchedule');
  const programInstructor = document.getElementById('programInstructor');
  const restrictedBadge = document.getElementById('restrictedBadge');
  const programDatesList = document.getElementById('programDatesList');
  const attendanceDateInput = document.getElementById('attendanceDate');
  const participantNameInput = document.getElementById('participantName');
  const birthDateInput = document.getElementById('birthDateInput');
  const submitBtn = document.getElementById('submitBtn');

  // 오류 표시 요소
  const nameError = document.getElementById('nameError');
  const birthError = document.getElementById('birthError');
  const genderError = document.getElementById('genderError');
  const consentError = document.getElementById('consentError');
  const formAlert = document.getElementById('formAlert');

  // 완료 화면 요약 요소
  const firstPlaceBanner = document.getElementById('firstPlaceBanner');
  const summaryProgramName = document.getElementById('summaryProgramName');
  const summaryAttendanceDate = document.getElementById('summaryAttendanceDate');
  const summaryParticipantName = document.getElementById('summaryParticipantName');

  if (IS_TEST_MODE && testModeBadge) {
    testModeBadge.classList.remove('hidden');
  }

  // --------------------------------------------------------------------------
  // 1. 생년월일 6자리 숫자 전용 입력 처리 (예: 950213)
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
  // 2. 오류 표시 헬퍼
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

  // 입력 중 오류 자동 해제 / blur 시 즉시 검증
  participantNameInput.addEventListener('input', () => {
    clearFieldError(nameError, [participantNameInput]);
    hideFormAlert();
  });

  participantNameInput.addEventListener('blur', () => {
    const raw = participantNameInput.value;
    if (!raw.trim() || !currentProgram) return;
    const check = validateParticipantName(raw, currentProgram.preRegisteredList);
    if (!check.valid) {
      showFieldError(nameError, check.message, [participantNameInput]);
    }
  });

  document.querySelectorAll('input[name="gender"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      clearFieldError(genderError);
      hideFormAlert();
    });
  });

  document.querySelectorAll('input[name="privacyConsent"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      clearFieldError(consentError);
      hideFormAlert();
    });
  });

  // --------------------------------------------------------------------------
  // 3. 화면 전환 헬퍼
  // --------------------------------------------------------------------------
  function showInvalidScreen(customMessage) {
    loadingSection.classList.add('hidden');
    formSection.classList.add('hidden');
    completeSection.classList.add('hidden');
    if (customMessage) {
      invalidMessage.textContent = customMessage;
    }
    invalidSection.classList.remove('hidden');
  }

  function showFormScreen(program) {
    currentProgram = program;

    const dates = parseProgramDates(
      Array.isArray(program.dates) && program.dates.length > 0 ? program.dates : program.date
    );
    const todayIso = getLocalIsoDate();

    programNameInput.value = program.name;
    programInstructor.textContent = `강사: ${program.instructor}`;

    programDatesList.innerHTML = '';
    if (dates.length > 1) {
      programSchedule.textContent = `총 ${dates.length}회기 · ${program.time}`;
      dates.forEach((d) => {
        const pill = document.createElement('span');
        pill.className = 'session-date-pill';
        if (d === todayIso) {
          pill.classList.add('is-today');
          pill.textContent = `${formatDateWithWeekday(d, true)} 오늘`;
        } else {
          pill.textContent = formatDateWithWeekday(d, true);
        }
        programDatesList.appendChild(pill);
      });
      programDatesList.classList.remove('hidden');
    } else {
      const displayDate = dates.length === 1 ? formatDateWithWeekday(dates[0]) : program.date;
      programSchedule.textContent = `${displayDate} · ${program.time}`;
      programDatesList.classList.add('hidden');
    }

    const preList = normalizePreRegisteredList(program.preRegisteredList);
    const isRestricted = Boolean(program.isRestricted) || preList.length > 0;
    if (isRestricted) {
      restrictedBadge.classList.remove('hidden');
    } else {
      restrictedBadge.classList.add('hidden');
    }

    // 접속 시점의 시스템 현지 날짜 (YYYY/MM/DD)
    attendanceDateInput.value = getLocalAttendanceDate();

    loadingSection.classList.add('hidden');
    invalidSection.classList.add('hidden');
    completeSection.classList.add('hidden');
    formSection.classList.remove('hidden');
  }

  function showCompleteScreen(summary) {
    if (summary.isFirstToday) {
      firstPlaceBanner.classList.remove('hidden');
    } else {
      firstPlaceBanner.classList.add('hidden');
    }

    summaryProgramName.textContent = summary.programName;
    summaryAttendanceDate.textContent = summary.attendanceDate;
    summaryParticipantName.textContent = summary.participantName;

    loadingSection.classList.add('hidden');
    invalidSection.classList.add('hidden');
    formSection.classList.add('hidden');
    completeSection.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // --------------------------------------------------------------------------
  // 4. 초기 진입: URL 파라미터(?code=gjyouth-XXXXXX) 확인 및 프로그램 조회
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

    try {
      const program = await fetchProgramByCode(code);
      if (!program) {
        showInvalidScreen(
          '유효하지 않은 프로그램 접근입니다. 현장에 비치된 QR코드를 다시 스캔해주세요.'
        );
        return;
      }

      showFormScreen(program);
    } catch (err) {
      showInvalidScreen(
        '프로그램 정보를 불러오는 중 오류가 발생했습니다. 잠시 후 QR코드를 다시 스캔해주세요.'
      );
    }
  }

  // --------------------------------------------------------------------------
  // 5. 출석 등록 제출 처리
  // --------------------------------------------------------------------------
  attendanceForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentProgram) return;

    hideFormAlert();
    clearFieldError(nameError, [participantNameInput]);
    clearFieldError(birthError, [birthDateInput]);
    clearFieldError(genderError);
    clearFieldError(consentError);

    let firstInvalidEl = null;

    // 1) 참가자명 검증 (형식 + 반복 + 블랙리스트 + 사전 명단 대조)
    const nameCheck = validateParticipantName(
      participantNameInput.value,
      currentProgram.preRegisteredList
    );
    if (!nameCheck.valid) {
      showFieldError(nameError, nameCheck.message, [participantNameInput]);
      firstInvalidEl = firstInvalidEl || participantNameInput;
    }

    // 2) 생년월일 6자리 검증 (YYMMDD -> YYYY-MM-DD)
    const birthCheck = parseBirthDate6(birthDateInput.value);
    if (!birthCheck.valid) {
      showFieldError(birthError, birthCheck.message, [birthDateInput]);
      firstInvalidEl = firstInvalidEl || birthDateInput;
    }

    // 3) 성별 검증
    const genderInput = document.querySelector('input[name="gender"]:checked');
    const genderVal = genderInput ? genderInput.value : '';
    if (!genderVal) {
      showFieldError(genderError, '성별을 선택해주세요.');
      firstInvalidEl = firstInvalidEl || document.getElementById('genderMale');
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

    // 5) 사전 신청자 3개 정보(이름, 생년월일, 성별) 정밀 대조
    const birthDate = birthCheck.iso;
    const rosterCheck = verifyPreRegisteredMatch(
      {
        name: nameCheck.cleanedName,
        birthDate,
        gender: genderVal,
      },
      currentProgram.preRegisteredList
    );

    if (!rosterCheck.matched) {
      if (rosterCheck.reason === 'not_in_roster') {
        showFieldError(nameError, rosterCheck.message, [participantNameInput]);
        participantNameInput.focus();
      } else {
        showFormAlert(rosterCheck.message);
      }
      return;
    }

    // 전송 데이터 구성
    const attendanceDate = attendanceDateInput.value;

    const payload = {
      programCode: currentProgram.code,
      programName: currentProgram.name,
      attendanceDate,
      participantName: nameCheck.cleanedName,
      birthDate,
      gender: genderVal,
      privacyConsent: consentVal,
    };

    submitBtn.disabled = true;
    submitBtn.textContent = '출석 등록 중...';

    try {
      const result = await submitAttendanceRecord(payload);

      if (result.status === 'success') {
        showCompleteScreen({
          programName: currentProgram.name,
          attendanceDate,
          participantName: nameCheck.cleanedName,
          isFirstToday: Boolean(result.data && result.data.isFirstToday),
        });
        return;
      }

      if (result.status === 'duplicate') {
        showFormAlert(result.message || '이미 출석 처리가 완료된 참가자입니다.');
        return;
      }

      if (result.status === 'not_in_roster') {
        showFieldError(
          nameError,
          result.message || '사전 신청 명단에 없는 이름입니다. 오타가 없는지 확인 후 다시 입력해주세요.',
          [participantNameInput]
        );
        participantNameInput.focus();
        return;
      }

      if (result.status === 'info_mismatch') {
        showFormAlert(
          result.message ||
            '사전 신청 정보(이름, 생년월일, 성별)가 일치하지 않습니다. 입력한 내용을 다시 확인해주세요.'
        );
        return;
      }

      showFormAlert(result.message || '출석 등록 중 오류가 발생했습니다. 다시 시도해주세요.');
    } catch (err) {
      showFormAlert('서버와의 통신에 실패했습니다. 네트워크 상태를 확인한 뒤 다시 시도해주세요.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '출석 등록하기';
    }
  });

  // 페이지 초기화 실행
  initPage();
});
