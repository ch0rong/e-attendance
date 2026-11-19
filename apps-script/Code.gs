/**
 * 찾아가는 청년센터 - 프로그램 참가자 출석 등록 시스템
 * Google Apps Script 백엔드 (apps-script/Code.gs)
 *
 * [시트 구성]
 * 1. 프로그램목록: 생성일시 | 프로그램코드 | 프로그램명 | 프로그램일자 | 프로그램시간 | 강사명 | 사전신청명단
 * 2. 참가자명단:   등록날짜 | 등록시간 | 프로그램코드 | 프로그램명 | 출석일자 | 참가자명 | 생년월일 | 연령구분 | 성별 | 개인정보동의
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
  '사전신청명단',
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
];

const TIMEZONE = 'Asia/Seoul';
const ADMIN_PASSWORD_PROPERTY_KEY = 'ADMIN_PASSWORD';

/**
 * 관리자 비밀번호 검증 (Apps Script > 프로젝트 설정 > 스크립트 속성에 ADMIN_PASSWORD 저장)
 * - 소스코드(GitHub)에 비밀번호를 노출하지 않고 Google 서버 내부 속성으로만 검증합니다.
 */
function verifyAdminPassword(providedPassword) {
  const savedPassword = PropertiesService
    .getScriptProperties()
    .getProperty(ADMIN_PASSWORD_PROPERTY_KEY);

  if (!savedPassword) {
    return {
      ok: false,
      status: 'config_error',
      message:
        '관리자 비밀번호가 서버에 설정되지 않았습니다. Apps Script [프로젝트 설정 → 스크립트 속성]에 ADMIN_PASSWORD를 등록해주세요.',
    };
  }

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
 * GET 요청 처리 (참가자 전용 공개 조회)
 * - ?action=getProgram&code=gjyouth-XXXXXX : 특정 프로그램 기본 정보 조회 (사전명단 개인정보 비노출)
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
      return handleGetProgram(code);
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
 * POST 요청 처리
 * - action === 'verifyAdmin'         : 관리자 비밀번호 서버 검증
 * - action === 'listPrograms'        : 전체 프로그램 목록 조회 (관리자 인증 필수)
 * - action === 'createProgram'       : 신규 프로그램 생성 및 저장 (관리자 인증 필수)
 * - action === 'updateProgram'       : 기존 프로그램 정보 수정 (관리자 인증 필수, 기존 출석기록 유지)
 * - action === 'deleteProgram'       : 프로그램(링크) 삭제 (관리자 인증 필수, 기존 출석기록 유지)
 * - action === 'registerParticipant' : 참가자 출석 등록 (사전명단 서버 대조 + 중복 차단 + 연령구분 + 오늘의 1등 판별)
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    // 동시 요청 충돌 방지를 위해 최대 30초 대기
    lock.waitLock(30000);

    if (!e || !e.postData || !e.postData.contents) {
      return createJsonResponse({
        status: 'error',
        message: '요청 데이터가 비어 있습니다.',
      });
    }

    const payload = JSON.parse(e.postData.contents);
    const action = String(payload.action || '').trim();

    // 관리자 전용 작업은 반드시 서버 측 비밀번호 검증 수행
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
      // Lock이 획득되지 않았을 때의 예외 무시
    }
  }
}

/**
 * 시트 조회 또는 자동 생성 (1행 헤더 포함)
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
  }

  return sheet;
}

/**
 * 사전 신청자 명단 파싱
 * - 구조화 배열([{ name, birthDate, gender }]), JSON 문자열, 구형 CSV 이름 문자열 모두 지원
 * - 이름+생년월일+성별 조합 기준 중복 제거
 */
function parsePreRegisteredList(raw) {
  let source = [];

  if (Array.isArray(raw)) {
    source = raw;
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    const trimmed = raw.trim();
    if (trimmed.charAt(0) === '[') {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          source = parsed;
        }
      } catch (err) {
        source = [];
      }
    } else {
      source = trimmed
        .split(/[,\r\n\t\s]+/)
        .map(function (item) {
          return item.trim();
        })
        .filter(function (item) {
          return item.length > 0;
        })
        .map(function (name) {
          return { name: name, birthDate: '', gender: '' };
        });
    }
  }

  const seen = {};
  const result = [];
  for (var i = 0; i < source.length; i++) {
    var entry = source[i];
    var name = '';
    var birthDate = '';
    var gender = '';

    if (typeof entry === 'string') {
      name = entry.trim();
    } else if (entry && typeof entry === 'object') {
      name = String(entry.name || '').trim();
      birthDate = String(entry.birthDate || '').trim();
      gender = String(entry.gender || '').trim();
    }

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
  return result;
}

/**
 * 사전 신청자 명단 시트 저장용 직렬화 (JSON 문자열)
 */
function serializePreRegisteredList(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return '';
  }
  return JSON.stringify(list);
}

/**
 * 프로그램 일자 파싱 (다회기 복수 날짜 지원: 중복 제거 + 오름차순 정렬)
 */
function parseProgramDates(raw) {
  let items = [];
  if (Array.isArray(raw)) {
    items = raw.map(function (item) {
      return String(item || '').trim();
    });
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    items = raw
      .split(/[,\r\n]+/)
      .map(function (item) {
        return item.trim();
      });
  }

  const seen = {};
  const result = [];
  for (var i = 0; i < items.length; i++) {
    var d = items[i];
    if (d && !seen[d]) {
      seen[d] = true;
      result.push(d);
    }
  }
  result.sort();
  return result;
}

/**
 * 시트 행 데이터를 프로그램 객체로 변환
 */
function rowToProgramObject(row) {
  const dates = parseProgramDates(row[3]);
  return {
    createdAt: String(row[0] || '').trim(),
    code: String(row[1] || '').trim(),
    name: String(row[2] || '').trim(),
    date: dates.join(', '),
    dates: dates,
    time: String(row[4] || '').trim(),
    instructor: String(row[5] || '').trim(),
    preRegisteredList: parsePreRegisteredList(row[6]),
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
 * GET: 특정 프로그램 기본 정보 반환
 * - 개인정보 보호를 위해 사전신청자 명단(이름·생년월일·성별) 원본은 참가자 브라우저로 전송하지 않음
 * - 대신 사전신청자 전용 여부(isRestricted)만 전달하고, 실제 명단 대조는 registerParticipant 서버 측에서 수행
 */
function handleGetProgram(code) {
  const program = findProgramByCode(code);
  if (!program) {
    return createJsonResponse({
      status: 'not_found',
      message: '유효하지 않은 프로그램 코드입니다.',
    });
  }

  return createJsonResponse({
    status: 'success',
    data: {
      code: program.code,
      name: program.name,
      date: program.date,
      dates: program.dates,
      time: program.time,
      instructor: program.instructor,
      isRestricted: program.preRegisteredList.length > 0,
      preRegisteredCount: program.preRegisteredList.length,
    },
  });
}

/**
 * GET: 전체 프로그램 목록 반환 (최신순)
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
 * POST: 프로그램 생성 및 저장
 */
function handleCreateProgram(payload) {
  const code = String(payload.code || '').trim();
  const name = String(payload.name || '').trim();
  const dates = parseProgramDates(
    Array.isArray(payload.dates) && payload.dates.length > 0 ? payload.dates : payload.date
  );
  const date = dates.join(', ');
  const time = String(payload.time || '').trim();
  const instructor = String(payload.instructor || '').trim();
  const preRegisteredList = parsePreRegisteredList(payload.preRegisteredList);

  if (!code || !name || dates.length === 0 || !time || !instructor) {
    return createJsonResponse({
      status: 'error',
      message: '필수 항목(프로그램 코드, 프로그램명, 일자, 시간, 강사명)을 모두 입력해주세요.',
    });
  }

  // 코드 중복 검사
  if (findProgramByCode(code)) {
    return createJsonResponse({
      status: 'duplicate_code',
      message: '이미 사용 중인 프로그램 코드입니다. 다시 시도해주세요.',
    });
  }

  const sheet = getOrCreateSheet(SHEET_PROGRAMS, PROGRAM_HEADERS);
  const createdAt = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  const preRegisteredSerialized = serializePreRegisteredList(preRegisteredList);

  const newRow = [
    createdAt,
    code,
    name,
    date,
    time,
    instructor,
    preRegisteredSerialized,
  ];

  const nextRow = sheet.getLastRow() + 1;
  const targetRange = sheet.getRange(nextRow, 1, 1, PROGRAM_HEADERS.length);
  targetRange.setNumberFormat('@');
  targetRange.setValues([newRow]);

  return createJsonResponse({
    status: 'success',
    message: '프로그램이 생성되었습니다.',
    data: {
      createdAt: createdAt,
      code: code,
      name: name,
      date: date,
      dates: dates,
      time: time,
      instructor: instructor,
      preRegisteredList: preRegisteredList,
    },
  });
}

/**
 * POST: 기존 프로그램 정보 수정
 * - 프로그램목록 시트의 해당 코드 행만 수정하며, 기존 참가자명단 시트 데이터는 변경하지 않음
 */
function handleUpdateProgram(payload) {
  const code = String(payload.code || '').trim();
  const name = String(payload.name || '').trim();
  const dates = parseProgramDates(
    Array.isArray(payload.dates) && payload.dates.length > 0 ? payload.dates : payload.date
  );
  const date = dates.join(', ');
  const time = String(payload.time || '').trim();
  const instructor = String(payload.instructor || '').trim();
  const preRegisteredList = parsePreRegisteredList(payload.preRegisteredList);

  if (!code || !name || dates.length === 0 || !time || !instructor) {
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
  let targetRowIndex = -1;
  let originalCreatedAt = '';

  for (var i = 0; i < values.length; i++) {
    if (String(values[i][1] || '').trim() === code) {
      targetRowIndex = i + 2; // 1-based sheet row
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

  const preRegisteredSerialized = serializePreRegisteredList(preRegisteredList);
  const updatedRow = [
    originalCreatedAt,
    code,
    name,
    date,
    time,
    instructor,
    preRegisteredSerialized,
  ];

  const targetRange = sheet.getRange(targetRowIndex, 1, 1, PROGRAM_HEADERS.length);
  targetRange.setNumberFormat('@');
  targetRange.setValues([updatedRow]);

  return createJsonResponse({
    status: 'success',
    message: '프로그램 정보가 수정되었습니다.',
    data: {
      createdAt: originalCreatedAt,
      code: code,
      name: name,
      date: date,
      dates: dates,
      time: time,
      instructor: instructor,
      preRegisteredList: preRegisteredList,
    },
  });
}

/**
 * POST: 프로그램(링크) 삭제
 * - 프로그램목록 시트에서 해당 코드 행만 삭제하며, 기존 참가자명단 시트 데이터는 유지
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
  let targetRowIndex = -1;

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
    message: '프로그램 링크가 삭제되었습니다.',
    data: {
      code: code,
    },
  });
}

/**
 * 생년월일 정규화 (YYMMDD 6자리 또는 YYYY-MM-DD -> YYYY-MM-DD)
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
    var currentYY = new Date().getFullYear() % 100;
    var fullYear = yy <= currentYY ? 2000 + yy : 1900 + yy;
    return fullYear + '-' + mm + '-' + dd;
  }
  return str;
}

/**
 * 연령구분 자동 판별 (출생연도 1987 ~ 2007 => '청년', 그 외 => '청년외')
 */
function calculateAgeGroup(birthDateStr) {
  const normalized = normalizeBirthDate(birthDateStr);
  const match = String(normalized || '').trim().match(/^(\d{4})/);
  if (!match) {
    return '청년외';
  }
  const birthYear = parseInt(match[1], 10);
  if (birthYear >= 1987 && birthYear <= 2007) {
    return '청년';
  }
  return '청년외';
}

/**
 * POST: 참가자 출석 등록
 */
function handleRegisterParticipant(payload) {
  const programCode = String(payload.programCode || '').trim();
  const attendanceDate = String(payload.attendanceDate || '').trim();
  const participantName = String(payload.participantName || '').trim();
  const birthDate = normalizeBirthDate(payload.birthDate);
  const gender = String(payload.gender || '').trim();
  const privacyConsent = String(payload.privacyConsent || '').trim();

  if (!programCode || !attendanceDate || !participantName || !birthDate || !gender) {
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

  // 1. 프로그램 존재 여부 및 사전 신청자 명단(이름·생년월일·성별) 대조
  const program = findProgramByCode(programCode);
  if (!program) {
    return createJsonResponse({
      status: 'not_found',
      message: '유효하지 않은 프로그램입니다.',
    });
  }

  if (program.preRegisteredList.length > 0) {
    var sameNameList = [];
    for (var r = 0; r < program.preRegisteredList.length; r++) {
      if (program.preRegisteredList[r].name === participantName) {
        sameNameList.push(program.preRegisteredList[r]);
      }
    }

    if (sameNameList.length === 0) {
      return createJsonResponse({
        status: 'not_in_roster',
        message: '사전 신청 명단에 없는 이름입니다. 오타가 없는지 확인 후 다시 입력해주세요.',
      });
    }

    var exactMatched = false;
    for (var s = 0; s < sameNameList.length; s++) {
      var candidate = sameNameList[s];
      var candidateBirth = candidate.birthDate ? normalizeBirthDate(candidate.birthDate) : '';
      var birthOk = !candidateBirth || candidateBirth === birthDate;
      var genderOk = !candidate.gender || candidate.gender === gender;
      if (birthOk && genderOk) {
        exactMatched = true;
        break;
      }
    }

    if (!exactMatched) {
      return createJsonResponse({
        status: 'info_mismatch',
        message: '사전 신청 정보(이름, 생년월일, 성별)가 일치하지 않습니다. 입력한 내용을 다시 확인해주세요.',
      });
    }
  }

  // 2. 중복 출석 검사 (프로그램코드 + 출석일자 + 참가자명 + 생년월일) 및 당일 첫 등록(1등) 여부 확인
  const sheet = getOrCreateSheet(SHEET_PARTICIPANTS, PARTICIPANT_HEADERS);
  const lastRow = sheet.getLastRow();
  var sameDayCount = 0;

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

      if (existingCode === programCode && existingAttDate === attendanceDate) {
        sameDayCount++;

        if (existingName === participantName && existingBirth === birthDate) {
          return createJsonResponse({
            status: 'duplicate',
            message: '이미 출석 처리가 완료된 참가자입니다.',
          });
        }
      }
    }
  }

  const isFirstToday = sameDayCount === 0;
  const todayOrder = sameDayCount + 1;

  // 3. 한국 표준시(Asia/Seoul) 기준 등록날짜 / 등록시간 분리 및 연령구분 자동 계산
  const now = new Date();
  const regDate = Utilities.formatDate(now, TIMEZONE, 'yyyy-MM-dd');
  const regTime = Utilities.formatDate(now, TIMEZONE, 'HH:mm:ss');
  const ageGroup = calculateAgeGroup(birthDate);

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
      isFirstToday: isFirstToday,
      todayOrder: todayOrder,
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
