/**
 * 광주시 청년지원센터 - 프로그램 참가자 출석 등록 시스템
 * Google Apps Script 백엔드 (apps-script/Code.gs)
 *
 * [시트 구성]
 * 1. 프로그램목록: 생성일시 | 프로그램코드 | 프로그램명 | 프로그램일자 | 프로그램시간 | 강사명 | 출석부명단 | 다회차여부 | 위치제한여부 | 장소명 | 위도 | 경도 | 허용반경 | 담당자확인코드
 * 2. 참가자명단:   등록날짜 | 등록시간 | 프로그램코드 | 프로그램명 | 출석일자 | 참가자명 | 생년월일 | 연령구분 | 성별 | 개인정보동의 | 기기ID | 비고 | 출석상태
 */

const SHEET_PROGRAMS = '프로그램목록';
const SHEET_PARTICIPANTS = '참가자명단';

const PROGRAM_HEADERS = [
  '생성일시',
  '프로그램코드',
  '프로그램명',
  '프로그램일자',
  '프로그램시간',
  '강사명',
  '출석부명단',
  '다회차여부',
  '위치제한여부',
  '장소명',
  '위도',
  '경도',
  '허용반경',
  '담당자확인코드',
];

const PARTICIPANT_HEADERS = [
  '등록날짜',
  '등록시간',
  '프로그램코드',
  '프로그램명',
  '출석일자',
  '참가자명',
  '생년월일',
  '연령구분',
  '성별',
  '개인정보동의',
  '기기ID',
  '비고',
  '출석상태',
];

const TIMEZONE = 'Asia/Seoul';
const ADMIN_PASSWORD_PROPERTY_KEY = 'ADMIN_PASSWORD';
const DEFAULT_ADMIN_PASSWORD = '1234';

const ERROR_MSG_NOT_IN_ROSTER = '출석부에 등록되어있지 않은 정보입니다.';
const ERROR_MSG_DEVICE_DUPLICATE = '이미 이 기기에서 출석 등록이 완료되었습니다.';
const ERROR_MSG_PARTICIPANT_DUPLICATE = '이미 출석 처리가 완료된 참가자입니다.';
const ERROR_MSG_GPS_FAILED = '위치 정보를 확인할 수 없습니다. 스마트폰의 위치(GPS) 권한을 허용해주세요.';
const ERROR_MSG_INVALID_MANAGER_CODE = '담당자 확인 코드가 일치하지 않습니다.';
const ERROR_MSG_BEFORE_CLASS = '수업 시작 전입니다.';
const ERROR_MSG_AFTER_CLASS = '수업이 종료되었습니다.';
const MANUAL_CONFIRM_NOTE = '담당자 수동확인';

/**
 * 관리자 비밀번호 검증
 * - 스크립트 속성(ADMIN_PASSWORD)이 설정되어 있으면 해당 값을 사용하고, 미설정 시 기본값('1234') 사용
 */
function verifyAdminPassword(providedPassword) {
  const savedPassword =
    PropertiesService.getScriptProperties().getProperty(ADMIN_PASSWORD_PROPERTY_KEY) ||
    DEFAULT_ADMIN_PASSWORD;

  const input = String(providedPassword || '');
  if (input !== savedPassword) {
    return {
      ok: false,
      status: 'unauthorized',
      message: '관리자 비밀번호가 일치하지 않습니다.',
    };
  }
  return { ok: true };
}

/**
 * GET 요청 처리
 * - ?action=getProgram&code=gjyouth-XXXXXX[&deviceId=...&deviceFingerprint=...&attendanceDate=...]
 */
function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const action = String(params.action || '').trim();

    if (action === 'getProgram') {
      const code = String(params.code || '').trim();
      if (!code) {
        return createJsonResponse({
          status: 'error',
          message: '프로그램 코드가 필요합니다.',
        });
      }
      return handleGetProgram(
        code,
        String(params.deviceId || '').trim(),
        String(params.deviceFingerprint || '').trim(),
        String(params.attendanceDate || '').trim()
      );
    }

    return createJsonResponse({
      status: 'error',
      message: '지원하지 않는 요청(action)입니다.',
    });
  } catch (err) {
    return createJsonResponse({
      status: 'error',
      message: '서버 처리 중 오류가 발생했습니다: ' + err.message,
    });
  }
}

/**
 * POST 요청 처리 (LockService로 동시 접속 충돌 방지)
 * - verifyAdmin / listPrograms / createProgram / updateProgram / deleteProgram
 * - verifyManagerCode / registerParticipant
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);

    if (!e || !e.postData || !e.postData.contents) {
      return createJsonResponse({
        status: 'error',
        message: '요청 데이터가 비어 있습니다.',
      });
    }

    const payload = JSON.parse(e.postData.contents);
    const action = String(payload.action || '').trim();

    if (
      action === 'verifyAdmin' ||
      action === 'listPrograms' ||
      action === 'createProgram' ||
      action === 'updateProgram' ||
      action === 'deleteProgram'
    ) {
      const auth = verifyAdminPassword(payload.adminPassword);
      if (!auth.ok) {
        return createJsonResponse({
          status: auth.status,
          message: auth.message,
        });
      }

      if (action === 'verifyAdmin') {
        return createJsonResponse({
          status: 'success',
          message: '관리자 인증이 완료되었습니다.',
        });
      }
      if (action === 'listPrograms') {
        return handleListPrograms();
      }
      if (action === 'createProgram') {
        return handleCreateProgram(payload);
      }
      if (action === 'updateProgram') {
        return handleUpdateProgram(payload);
      }
      if (action === 'deleteProgram') {
        return handleDeleteProgram(payload);
      }
    }

    if (action === 'verifyManagerCode') {
      return handleVerifyManagerCode(payload);
    }

    if (action === 'registerParticipant') {
      return handleRegisterParticipant(payload);
    }

    return createJsonResponse({
      status: 'error',
      message: '지원하지 않는 요청(action)입니다.',
    });
  } catch (err) {
    return createJsonResponse({
      status: 'error',
      message: '서버 처리 중 오류가 발생했습니다: ' + err.message,
    });
  } finally {
    try {
      lock.releaseLock();
    } catch (releaseErr) {
      // Lock 미획득 시 예외 무시
    }
  }
}

/**
 * 시트 조회 또는 자동 생성 (기존 시트에 누락된 우측 헤더 열 자동 보완 포함)
 */
function getOrCreateSheet(sheetName, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setValues([headers]);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#f1f5f9');
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setValues([headers]);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#f1f5f9');
    sheet.setFrozenRows(1);
  } else if (sheet.getLastColumn() < headers.length) {
    const existingColCount = sheet.getLastColumn();
    const missingHeaders = headers.slice(existingColCount);
    const missingRange = sheet.getRange(1, existingColCount + 1, 1, missingHeaders.length);
    missingRange.setValues([missingHeaders]);
    missingRange.setFontWeight('bold');
    missingRange.setBackground('#f1f5f9');
  }

  return sheet;
}

/**
 * 불리언 플래그 파싱 ('Y' / 'TRUE' / true -> true)
 */
function parseBoolFlag(val) {
  if (val === true) return true;
  const s = String(val || '').trim().toUpperCase();
  return s === 'Y' || s === 'TRUE' || s === '1' || s === 'YES';
}

function toSheetFlag(val) {
  return parseBoolFlag(val) ? 'Y' : 'N';
}

/**
 * 성별 문자열 정규화 ('남성' -> '남', '여성' -> '여')
 */
function normalizeGender(raw) {
  const val = String(raw || '').trim();
  if (val === '남' || val === '남성') return '남';
  if (val === '여' || val === '여성') return '여';
  return val;
}

/**
 * 생년월일 정규화 (YYMMDD 6자리 또는 YYYY-MM-DD -> YYYY-MM-DD)
 * - 60~99 => 1960~1999, 00~12 => 2000~2012
 */
function normalizeBirthDate(raw) {
  const str = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }
  const digits = str.replace(/\D/g, '');
  if (/^\d{6}$/.test(digits)) {
    var yy = parseInt(digits.slice(0, 2), 10);
    var mm = digits.slice(2, 4);
    var dd = digits.slice(4, 6);
    var fullYear = null;
    if (yy >= 60 && yy <= 99) {
      fullYear = 1900 + yy;
    } else if (yy >= 0 && yy <= 12) {
      fullYear = 2000 + yy;
    }
    if (fullYear !== null) {
      return fullYear + '-' + mm + '-' + dd;
    }
  }
  return str;
}

/**
 * 하버사인(Haversine) 직선거리(m) 계산
 */
function calculateHaversineDistanceMeters(lat1, lon1, lat2, lon2) {
  var R = 6371000;
  var toRad = function (deg) {
    return (deg * Math.PI) / 180;
  };
  var dLat = toRad(lat2 - lat1);
  var dLon = toRad(lon2 - lon1);
  var a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * 출석부 명단 파싱 + 중복 제거 + 한글 가나다순 오름차순 자동 정렬
 */
function parseRosterList(raw) {
  let source = [];

  if (Array.isArray(raw)) {
    source = raw;
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    const trimmed = raw.trim();
    if (trimmed.charAt(0) === '[') {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) source = parsed;
      } catch (err) {
        source = [];
      }
    }
  }

  const seen = {};
  const result = [];
  for (var i = 0; i < source.length; i++) {
    var entry = source[i];
    if (!entry || typeof entry !== 'object') continue;

    var name = String(entry.name || '').replace(/\s+/g, '');
    var birthDate = normalizeBirthDate(entry.birthDate || '');
    var gender = normalizeGender(entry.gender);
    if (!name) continue;

    var key = name + '|' + birthDate + '|' + gender;
    if (!seen[key]) {
      seen[key] = true;
      result.push({
        name: name,
        birthDate: birthDate,
        gender: gender,
      });
    }
  }

  result.sort(function (a, b) {
    var nameDiff = a.name.localeCompare(b.name, 'ko-KR');
    if (nameDiff !== 0) return nameDiff;
    return String(a.birthDate || '').localeCompare(String(b.birthDate || ''));
  });

  return result;
}

function serializeRosterList(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return '';
  }
  return JSON.stringify(list);
}

/**
 * 기기ID 열 직렬화/파싱 (기기ID + 보조 지문 deviceFingerprint 함께 저장/대조)
 */
function formatDeviceCell(deviceId, deviceFingerprint) {
  const id = String(deviceId || '').trim();
  const fp = String(deviceFingerprint || '').trim();
  if (id && fp) return id + '::' + fp;
  return id || fp;
}

function parseDeviceCell(cellValue) {
  const raw = String(cellValue || '').trim();
  if (!raw) {
    return { deviceId: '', deviceFingerprint: '' };
  }
  const idx = raw.indexOf('::');
  if (idx === -1) {
    return { deviceId: raw, deviceFingerprint: '' };
  }
  return {
    deviceId: raw.slice(0, idx).trim(),
    deviceFingerprint: raw.slice(idx + 2).trim(),
  };
}

function isSameDeviceRecord(cellValue, deviceId, deviceFingerprint) {
  const stored = parseDeviceCell(cellValue);
  if (deviceId && stored.deviceId && stored.deviceId === deviceId) {
    return true;
  }
  if (deviceFingerprint && stored.deviceFingerprint && stored.deviceFingerprint === deviceFingerprint) {
    return true;
  }
  return false;
}

/**
 * 시트 행 데이터를 프로그램 객체로 변환 (14열)
 */
function rowToProgramObject(row) {
  const roster = parseRosterList(row[6]);
  const isMultiSession = parseBoolFlag(row[7]);
  const locationEnabled = parseBoolFlag(row[8]);
  const locationName = String(row[9] || '').trim();
  const latitude = String(row[10] || '').trim();
  const longitude = String(row[11] || '').trim();
  const allowedRadius = Number(row[12]) || 300;
  const managerCode = String(row[13] || '').trim();

  return {
    createdAt: String(row[0] || '').trim(),
    code: String(row[1] || '').trim(),
    name: String(row[2] || '').trim(),
    date: String(row[3] || '').trim(),
    time: String(row[4] || '').trim(),
    instructor: String(row[5] || '').trim(),
    roster: roster,
    preRegisteredList: roster,
    isMultiSession: isMultiSession,
    locationEnabled: locationEnabled,
    locationName: locationName,
    latitude: latitude,
    longitude: longitude,
    allowedRadius: allowedRadius,
    managerCode: managerCode,
  };
}

/**
 * 특정 프로그램 코드 조회
 */
function findProgramByCode(code) {
  const sheet = getOrCreateSheet(SHEET_PROGRAMS, PROGRAM_HEADERS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return null;
  }

  const values = sheet.getRange(2, 1, lastRow - 1, PROGRAM_HEADERS.length).getDisplayValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][1] || '').trim() === code) {
      return rowToProgramObject(values[i]);
    }
  }
  return null;
}

/**
 * 특정 기기(deviceId 또는 deviceFingerprint)가 동일 프로그램·동일 출석일자에 이미 제출했는지 확인
 */
function hasDeviceAlreadySubmitted(programCode, attendanceDate, deviceId, deviceFingerprint) {
  if (!deviceId && !deviceFingerprint) return false;

  const sheet = getOrCreateSheet(SHEET_PARTICIPANTS, PARTICIPANT_HEADERS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  const rows = sheet.getRange(2, 1, lastRow - 1, PARTICIPANT_HEADERS.length).getDisplayValues();

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var existingCode = String(row[2] || '').trim();
    var existingAttDate = String(row[4] || '').trim();
    var existingDeviceCell = String(row[10] || '').trim();

    if (existingCode === programCode && existingAttDate === attendanceDate) {
      if (isSameDeviceRecord(existingDeviceCell, deviceId, deviceFingerprint)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * GET: 특정 프로그램 기본 정보 반환
 * - 개인정보/보안 보호를 위해 출석부 원본 명단과 담당자확인코드 원문은 브라우저로 노출하지 않음
 */
function handleGetProgram(code, deviceId, deviceFingerprint, attendanceDate) {
  const program = findProgramByCode(code);
  if (!program) {
    return createJsonResponse({
      status: 'not_found',
      message: '유효하지 않은 프로그램 코드입니다.',
    });
  }

  const targetAttendanceDate =
    attendanceDate || Utilities.formatDate(new Date(), TIMEZONE, 'yyyy/MM/dd');
  const alreadySubmittedOnDevice = hasDeviceAlreadySubmitted(
    program.code,
    targetAttendanceDate,
    deviceId,
    deviceFingerprint
  );

  return createJsonResponse({
    status: 'success',
    data: {
      code: program.code,
      name: program.name,
      date: program.date,
      time: program.time,
      instructor: program.instructor,
      rosterCount: program.roster.length,
      isMultiSession: program.isMultiSession,
      locationEnabled: program.locationEnabled,
      locationName: program.locationName,
      latitude: program.latitude,
      longitude: program.longitude,
      allowedRadius: program.allowedRadius,
      hasManagerCode: Boolean(program.managerCode),
      alreadySubmittedOnDevice: alreadySubmittedOnDevice,
    },
  });
}

/**
 * 프로그램별 담당자 확인 코드 검증 (기존 미설정 프로그램은 관리자 비밀번호를 폴백으로 허용)
 */
function isValidProgramManagerCode(program, providedCode) {
  const input = String(providedCode || '').trim();
  if (!input) return false;
  const expected =
    String((program && program.managerCode) || '').trim() ||
    PropertiesService.getScriptProperties().getProperty(ADMIN_PASSWORD_PROPERTY_KEY) ||
    DEFAULT_ADMIN_PASSWORD;
  return input === expected;
}

/**
 * POST: 담당자 확인 코드 검증 (수동 출석 모달 사전 확인용)
 */
function handleVerifyManagerCode(payload) {
  const programCode = String(payload.programCode || '').trim();
  const managerCode = String(payload.managerCode || '').trim();

  if (!programCode || !managerCode) {
    return createJsonResponse({
      status: 'invalid_manager_code',
      message: ERROR_MSG_INVALID_MANAGER_CODE,
    });
  }

  const program = findProgramByCode(programCode);
  if (!program) {
    return createJsonResponse({
      status: 'not_found',
      message: '유효하지 않은 프로그램입니다.',
    });
  }

  if (!isValidProgramManagerCode(program, managerCode)) {
    return createJsonResponse({
      status: 'invalid_manager_code',
      message: ERROR_MSG_INVALID_MANAGER_CODE,
    });
  }

  return createJsonResponse({
    status: 'success',
    message: '담당자 확인 코드가 확인되었습니다.',
  });
}

/**
 * POST(관리자): 전체 프로그램 목록 조회 (최신순)
 */
function handleListPrograms() {
  const sheet = getOrCreateSheet(SHEET_PROGRAMS, PROGRAM_HEADERS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return createJsonResponse({
      status: 'success',
      data: [],
    });
  }

  const values = sheet.getRange(2, 1, lastRow - 1, PROGRAM_HEADERS.length).getDisplayValues();
  const programs = [];
  for (var i = values.length - 1; i >= 0; i--) {
    var code = String(values[i][1] || '').trim();
    if (code) {
      programs.push(rowToProgramObject(values[i]));
    }
  }

  return createJsonResponse({
    status: 'success',
    data: programs,
  });
}

/**
 * POST(관리자): 신규 프로그램 및 출석부·위치·다회차 설정 저장
 */
function handleCreateProgram(payload) {
  const code = String(payload.code || '').trim();
  const name = String(payload.name || '').trim();
  const date = String(payload.date || '').trim();
  const time = String(payload.time || '').trim();
  const instructor = String(payload.instructor || '').trim();
  const roster = parseRosterList(payload.roster || payload.preRegisteredList);
  const isMultiSession = parseBoolFlag(payload.isMultiSession);
  const locationEnabled = parseBoolFlag(payload.locationEnabled);
  const locationName = locationEnabled ? String(payload.locationName || '').trim() : '';
  const latitude = locationEnabled ? String(payload.latitude || '').trim() : '';
  const longitude = locationEnabled ? String(payload.longitude || '').trim() : '';
  const allowedRadius = locationEnabled ? Number(payload.allowedRadius) || 300 : '';
  const managerCode = String(payload.managerCode || '').trim();

  if (!code || !name || !date || !time || !instructor) {
    return createJsonResponse({
      status: 'error',
      message: '필수 항목(프로그램 코드, 프로그램명, 일자, 시간, 강사명)을 모두 입력해주세요.',
    });
  }

  if (findProgramByCode(code)) {
    return createJsonResponse({
      status: 'duplicate_code',
      message: '이미 사용 중인 프로그램 코드입니다. 다시 시도해주세요.',
    });
  }

  const sheet = getOrCreateSheet(SHEET_PROGRAMS, PROGRAM_HEADERS);
  const createdAt = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  const rosterSerialized = serializeRosterList(roster);

  const newRow = [
    createdAt,
    code,
    name,
    date,
    time,
    instructor,
    rosterSerialized,
    toSheetFlag(isMultiSession),
    toSheetFlag(locationEnabled),
    locationName,
    latitude,
    longitude,
    allowedRadius === '' ? '' : String(allowedRadius),
    managerCode,
  ];

  const nextRow = sheet.getLastRow() + 1;
  const targetRange = sheet.getRange(nextRow, 1, 1, PROGRAM_HEADERS.length);
  targetRange.setNumberFormat('@');
  targetRange.setValues([newRow]);

  return createJsonResponse({
    status: 'success',
    message: '프로그램이 생성되었습니다.',
    data: rowToProgramObject(newRow),
  });
}

/**
 * POST(관리자): 기존 프로그램 정보 수정 (기존 참가자명단 출석 기록 유지)
 */
function handleUpdateProgram(payload) {
  const code = String(payload.code || '').trim();
  const name = String(payload.name || '').trim();
  const date = String(payload.date || '').trim();
  const time = String(payload.time || '').trim();
  const instructor = String(payload.instructor || '').trim();
  const roster = parseRosterList(payload.roster || payload.preRegisteredList);
  const isMultiSession = parseBoolFlag(payload.isMultiSession);
  const locationEnabled = parseBoolFlag(payload.locationEnabled);
  const locationName = locationEnabled ? String(payload.locationName || '').trim() : '';
  const latitude = locationEnabled ? String(payload.latitude || '').trim() : '';
  const longitude = locationEnabled ? String(payload.longitude || '').trim() : '';
  const allowedRadius = locationEnabled ? Number(payload.allowedRadius) || 300 : '';
  const managerCode = String(payload.managerCode || '').trim();

  if (!code || !name || !date || !time || !instructor) {
    return createJsonResponse({
      status: 'error',
      message: '필수 항목(프로그램 코드, 프로그램명, 일자, 시간, 강사명)을 모두 입력해주세요.',
    });
  }

  const sheet = getOrCreateSheet(SHEET_PROGRAMS, PROGRAM_HEADERS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return createJsonResponse({
      status: 'not_found',
      message: '수정할 프로그램을 찾을 수 없습니다.',
    });
  }

  const values = sheet.getRange(2, 1, lastRow - 1, PROGRAM_HEADERS.length).getDisplayValues();
  var targetRowIndex = -1;
  var originalCreatedAt = '';

  for (var i = 0; i < values.length; i++) {
    if (String(values[i][1] || '').trim() === code) {
      targetRowIndex = i + 2;
      originalCreatedAt = String(values[i][0] || '').trim();
      break;
    }
  }

  if (targetRowIndex === -1) {
    return createJsonResponse({
      status: 'not_found',
      message: '수정할 프로그램을 찾을 수 없습니다.',
    });
  }

  const rosterSerialized = serializeRosterList(roster);
  const updatedRow = [
    originalCreatedAt,
    code,
    name,
    date,
    time,
    instructor,
    rosterSerialized,
    toSheetFlag(isMultiSession),
    toSheetFlag(locationEnabled),
    locationName,
    latitude,
    longitude,
    allowedRadius === '' ? '' : String(allowedRadius),
    managerCode,
  ];

  const targetRange = sheet.getRange(targetRowIndex, 1, 1, PROGRAM_HEADERS.length);
  targetRange.setNumberFormat('@');
  targetRange.setValues([updatedRow]);

  return createJsonResponse({
    status: 'success',
    message: '프로그램 정보가 수정되었습니다.',
    data: rowToProgramObject(updatedRow),
  });
}

/**
 * POST(관리자): 프로그램 삭제 (기존 참가자명단 출석 기록 유지)
 */
function handleDeleteProgram(payload) {
  const code = String(payload.code || '').trim();
  if (!code) {
    return createJsonResponse({
      status: 'error',
      message: '삭제할 프로그램 코드가 필요합니다.',
    });
  }

  const sheet = getOrCreateSheet(SHEET_PROGRAMS, PROGRAM_HEADERS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return createJsonResponse({
      status: 'not_found',
      message: '삭제할 프로그램을 찾을 수 없습니다.',
    });
  }

  const values = sheet.getRange(2, 1, lastRow - 1, PROGRAM_HEADERS.length).getDisplayValues();
  var targetRowIndex = -1;

  for (var i = 0; i < values.length; i++) {
    if (String(values[i][1] || '').trim() === code) {
      targetRowIndex = i + 2;
      break;
    }
  }

  if (targetRowIndex === -1) {
    return createJsonResponse({
      status: 'not_found',
      message: '삭제할 프로그램을 찾을 수 없습니다.',
    });
  }

  sheet.deleteRow(targetRowIndex);

  return createJsonResponse({
    status: 'success',
    message: '프로그램이 삭제되었습니다.',
    data: { code: code },
  });
}

/**
 * 연도별 청년 연령 자동 계산 (하드코딩 금지)
 * - 등록 연도(currentYear) 기준 연 나이 19세~39세
 *   (currentYear - 39 이상 currentYear - 19 이하) => '청년', 그 외 => '청년외'
 */
function calculateAgeGroup(birthDateStr, currentYear) {
  const yearNum =
    Number(currentYear) || Number(Utilities.formatDate(new Date(), TIMEZONE, 'yyyy'));
  const normalized = normalizeBirthDate(birthDateStr);
  const match = String(normalized || '').trim().match(/^(\d{4})/);
  if (!match) {
    return '청년외';
  }
  const birthYear = parseInt(match[1], 10);
  const minYouthBirthYear = yearNum - 39;
  const maxYouthBirthYear = yearNum - 19;

  if (birthYear >= minYouthBirthYear && birthYear <= maxYouthBirthYear) {
    return '청년';
  }
  return '청년외';
}

/**
 * 단일 시간 문자열(예: "14:00", "오후 2:30", "18시 30분")을 자정 기준 초로 변환
 */
function parseSingleTimeToSeconds(token) {
  var str = String(token || '').trim();
  if (!str) return null;

  var period = '';
  var hour = NaN;
  var minute = 0;

  var colonMatch = str.match(/^(오전|오후)?\s*(\d{1,2})\s*:\s*(\d{2})$/);
  if (colonMatch) {
    period = colonMatch[1] || '';
    hour = parseInt(colonMatch[2], 10);
    minute = parseInt(colonMatch[3], 10);
  } else {
    var korMatch = str.match(/^(오전|오후)?\s*(\d{1,2})시(?:\s*(\d{1,2})분?)?$/);
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
 * 프로그램 시간 문자열(예: "14:00 ~ 16:00", "18:00-20:00") 파싱
 */
function parseProgramTimeRange(timeStr) {
  var raw = String(timeStr || '').trim();
  if (!raw) return null;

  var parts = raw.split(/\s*(?:~|-|–|—)\s*/);
  if (parts.length !== 2) return null;

  var startSec = parseSingleTimeToSeconds(parts[0]);
  var endSec = parseSingleTimeToSeconds(parts[1]);
  if (startSec === null || endSec === null || endSec < startSec) return null;

  return { startSec: startSec, endSec: endSec };
}

function parseHmsToSeconds(hmsStr) {
  var match = String(hmsStr || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  var hh = parseInt(match[1], 10);
  var mm = parseInt(match[2], 10);
  var ss = match[3] ? parseInt(match[3], 10) : 0;
  return hh * 3600 + mm * 60 + ss;
}

/**
 * 출석 등록 가능 시간 검증 및 지각 자동 판정
 * - 등록 가능 시간: [수업 시작 30분 전] ~ [수업 종료 10분 후]
 *   - 수업 시작 30분 전 이전 => "수업 시작 전입니다."
 *   - 수업 종료 10분 후 이후 => "수업이 종료되었습니다."
 * - 지각 판정:
 *   - [수업 시작 시간 + 30분] 이상 (예: 18:00 수업일 때 18:30:00부터) => "지각"
 *   - 그 이전 정상 출석 => "" (빈칸)
 */
function evaluateClassAttendanceTime(programTimeStr, regTimeHms) {
  var range = parseProgramTimeRange(programTimeStr);
  if (!range) {
    return { allowed: true, attendanceStatus: '' };
  }

  var nowSec = parseHmsToSeconds(regTimeHms);
  if (nowSec === null) {
    return { allowed: true, attendanceStatus: '' };
  }

  var openSec = range.startSec - 30 * 60;
  var lateSec = range.startSec + 30 * 60;
  var closeSec = range.endSec + 10 * 60;

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
 * POST: 참가자 본인 출석 등록 (일반 GPS 출석 + 담당자 수동 출석 승인)
 */
function handleRegisterParticipant(payload) {
  const programCode = String(payload.programCode || '').trim();
  const participantName = String(payload.participantName || '').replace(/\s+/g, '');
  const birthDate = normalizeBirthDate(payload.birthDate);
  const gender = normalizeGender(payload.gender);
  const privacyConsent = String(payload.privacyConsent || '').trim();
  const deviceId = String(payload.deviceId || '').trim();
  const deviceFingerprint = String(payload.deviceFingerprint || '').trim();
  const manualOverride = parseBoolFlag(payload.manualOverride);
  const managerCode = String(payload.managerCode || '').trim();

  if (!programCode || !participantName || !birthDate || !gender) {
    return createJsonResponse({
      status: 'error',
      message: '필수 입력 항목이 누락되었습니다.',
    });
  }

  if (privacyConsent !== '동의함') {
    return createJsonResponse({
      status: 'error',
      message: '개인정보 수집 및 이용에 동의하셔야 출석 등록이 가능합니다.',
    });
  }

  // 1. 프로그램 존재 여부 확인
  const program = findProgramByCode(programCode);
  if (!program) {
    return createJsonResponse({
      status: 'not_found',
      message: '유효하지 않은 프로그램입니다.',
    });
  }

  // 2. 담당자 수동 출석 승인 요청 시 확인 코드 검증
  if (manualOverride) {
    if (!isValidProgramManagerCode(program, managerCode)) {
      return createJsonResponse({
        status: 'invalid_manager_code',
        message: ERROR_MSG_INVALID_MANAGER_CODE,
      });
    }
  }

  // 3. 한국 표준시(Asia/Seoul) 기준 등록날짜 / 등록시간 / 등록연도 생성
  const now = new Date();
  const currentYear = Number(Utilities.formatDate(now, TIMEZONE, 'yyyy'));
  const regDate = Utilities.formatDate(now, TIMEZONE, 'yyyy-MM-dd');
  const regTime = Utilities.formatDate(now, TIMEZONE, 'HH:mm:ss');
  const attendanceDate =
    String(payload.attendanceDate || '').trim() ||
    Utilities.formatDate(now, TIMEZONE, 'yyyy/MM/dd');

  // 4. 프로그램 일자 유효성 검증 (다회차 프로그램이 아닌 경우 설정된 일자와 당일 일치 필요)
  if (!program.isMultiSession && program.date && program.date !== regDate) {
    return createJsonResponse({
      status: 'invalid_date',
      message: '출석 가능한 일자가 아닙니다. (프로그램 일자: ' + program.date + ')',
    });
  }

  // 4-2. 출석 등록 가능 시간 검증 ([수업 시작 30분 전] ~ [수업 종료 10분 후]) 및 지각 자동 판정
  const timeEval = evaluateClassAttendanceTime(program.time, regTime);
  if (!manualOverride && !timeEval.allowed) {
    return createJsonResponse({
      status: timeEval.status,
      message: timeEval.message,
    });
  }

  // 5. 위치 기반 출석 반경 검증 (담당자 수동 출석 승인 시 우회)
  if (program.locationEnabled && !manualOverride) {
    var targetLat = Number(program.latitude);
    var targetLng = Number(program.longitude);
    var userLat = payload.userLat !== null && payload.userLat !== undefined && payload.userLat !== ''
      ? Number(payload.userLat)
      : NaN;
    var userLng = payload.userLng !== null && payload.userLng !== undefined && payload.userLng !== ''
      ? Number(payload.userLng)
      : NaN;
    var allowedRadius = Number(program.allowedRadius) || 300;

    if (isNaN(userLat) || isNaN(userLng) || isNaN(targetLat) || isNaN(targetLng)) {
      return createJsonResponse({
        status: 'gps_error',
        message: ERROR_MSG_GPS_FAILED,
      });
    }

    var distance = calculateHaversineDistanceMeters(targetLat, targetLng, userLat, userLng);
    if (distance > allowedRadius) {
      return createJsonResponse({
        status: 'out_of_range',
        message: '지정된 프로그램 장소 인근(반경 ' + allowedRadius + 'm 이내)에서만 출석 등록이 가능합니다.',
      });
    }
  }

  // 6. 출석부 명단 대조 (이름 + 생년월일 + 성별 정확 일치 확인)
  if (program.roster.length > 0) {
    var exactMatched = false;
    for (var r = 0; r < program.roster.length; r++) {
      var candidate = program.roster[r];
      if (
        candidate.name === participantName &&
        normalizeBirthDate(candidate.birthDate) === birthDate &&
        normalizeGender(candidate.gender) === gender
      ) {
        exactMatched = true;
        break;
      }
    }

    if (!exactMatched) {
      return createJsonResponse({
        status: 'not_in_roster',
        message: ERROR_MSG_NOT_IN_ROSTER,
      });
    }
  }

  // 7. 중복 출석 및 대리 출석 차단 (같은 프로그램코드 + 출석일자 기준)
  const sheet = getOrCreateSheet(SHEET_PARTICIPANTS, PARTICIPANT_HEADERS);
  const lastRow = sheet.getLastRow();

  if (lastRow >= 2) {
    const existingRows = sheet
      .getRange(2, 1, lastRow - 1, PARTICIPANT_HEADERS.length)
      .getDisplayValues();

    for (var i = 0; i < existingRows.length; i++) {
      var row = existingRows[i];
      var existingCode = String(row[2] || '').trim();
      var existingAttDate = String(row[4] || '').trim();
      var existingName = String(row[5] || '').trim();
      var existingBirth = String(row[6] || '').trim();
      var existingDeviceCell = String(row[10] || '').trim();

      if (existingCode === programCode && existingAttDate === attendanceDate) {
        // ① 동일한 기기ID 또는 보조 지문 차단 (담당자 수동 출석 승인 시 우회)
        if (!manualOverride && isSameDeviceRecord(existingDeviceCell, deviceId, deviceFingerprint)) {
          return createJsonResponse({
            status: 'device_duplicate',
            message: ERROR_MSG_DEVICE_DUPLICATE,
          });
        }

        // ② 동일한 참가자명 + 생년월일 중복 출석 차단
        if (existingName === participantName && existingBirth === birthDate) {
          return createJsonResponse({
            status: 'duplicate',
            message: ERROR_MSG_PARTICIPANT_DUPLICATE,
          });
        }
      }
    }
  }

  const ageGroup = calculateAgeGroup(birthDate, currentYear);
  const deviceCellValue = formatDeviceCell(deviceId, deviceFingerprint);
  const note = manualOverride ? MANUAL_CONFIRM_NOTE : '';
  const attendanceStatus = timeEval.attendanceStatus;

  const newRow = [
    regDate,
    regTime,
    programCode,
    program.name,
    attendanceDate,
    participantName,
    birthDate,
    ageGroup,
    gender,
    privacyConsent,
    deviceCellValue,
    note,
    attendanceStatus,
  ];

  const nextRow = sheet.getLastRow() + 1;
  const targetRange = sheet.getRange(nextRow, 1, 1, PARTICIPANT_HEADERS.length);
  targetRange.setNumberFormat('@');
  targetRange.setValues([newRow]);

  return createJsonResponse({
    status: 'success',
    message: '출석이 완료되었습니다.',
    data: {
      regDate: regDate,
      regTime: regTime,
      programCode: programCode,
      programName: program.name,
      attendanceDate: attendanceDate,
      participantName: participantName,
      birthDate: birthDate,
      ageGroup: ageGroup,
      gender: gender,
      privacyConsent: privacyConsent,
      deviceId: deviceId,
      note: note,
      attendanceStatus: attendanceStatus,
    },
  });
}

/**
 * JSON 응답 생성 헬퍼
 */
function createJsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
