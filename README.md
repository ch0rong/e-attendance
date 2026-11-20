# 프로그램 참가자 출석 등록 시스템

별도 프레임워크 없이 순수 **HTML, CSS, Vanilla JS**로 구축되어 **GitHub Pages**에 바로 배포할 수 있는 프로그램 출석 등록 웹 애플리케이션입니다.  
백엔드 데이터베이스는 **Google Apps Script + Google Sheets**로 연동됩니다.

---

## 1. 폴더 구조

```text
e-attendance/
├── index.html              # 참가자 본인 출석 등록 페이지 (?code=gjyouth-XXXXXX)
├── admin.html              # 관리자용 프로그램 및 출석부 생성 페이지
├── style.css               # 공통 스타일시트 (반응형 + @font-face 선언)
├── app.js                  # 참가자 본인 출석 등록 및 대리 출석 방지 로직
├── admin.js                # 관리자 프로그램/출석부 일괄 생성 로직
├── apps-script/
│   └── Code.gs             # Google Sheets 연동 백엔드 (Google Apps Script)
├── assets/
│   ├── images/             # 로고 이미지 폴더 (logo.png)
│   └── fonts/              # 커스텀 폰트 폴더 (NEXON Football Gothic B / L)
└── README.md               # 설치, Google Sheets 세팅 및 배포 가이드
```

---

## 2. 주요 기능

### 상단/하단 레이아웃 및 폰트
- `index.html`, `admin.html` 상단 헤더에 텍스트 타이틀 없이 로고 이미지(`assets/images/logo.png`)만 가로 중앙 정렬로 배치 (`max-height: 52px` 비율 유지).
- 로고 클릭 시 `https://www.gj-youth.or.kr` 새 탭 이동.
- 페이지 하단(`footer`)은 텍스트 없이 깔끔하게 비워둠.
- `assets/fonts/` 내 `NEXON Football Gothic L`(300) / `NEXON Football Gothic B`(700) `@font-face` 적용 및 시스템 산세리프 폰트 fallback 지원.

### 관리자 페이지 (`admin.html`, `admin.js`)
- 진입 시 관리자 비밀번호 확인 창 표시 (`ADMIN_PASSWORD = "1234"` 기본 상수).
- 프로그램 기본 정보 입력: 프로그램명, 프로그램 일자(컴팩트 `<input type="date">`), 프로그램 시간(예: `14:00 ~ 16:00`), 강사명.
- 출석부 명단 일괄 입력(선택사항):
  - 참가자 1명당 1줄 가로 그리드: `이름` / `생년월일 드롭다운([연도 2012~1960][월][일], 기본 2000-01-01)` / `성별 토글([남][여])` / `행 삭제(×, 2번째 행부터 표시)`.
  - `[+ 참가자 추가]` 버튼으로 행 다중 추가 및 개별 삭제 가능.
  - 저장 시 공백 행 무시, 일부만 입력된 행 경고, 한글 완성형 2~5자 및 중복 검증 후 **이름 기준 한글 가나다순 오름차순(`localeCompare(..., 'ko-KR')`) 자동 정렬**.
  - 고유 프로그램 코드(`gjyouth-` + 6자리 영문 대문자/숫자) 자동 발급 및 전용 출석 URL 원클릭 **[링크 복사]** 제공.
  - 기존 생성된 프로그램 목록 조회 / 수정 / 삭제 지원.

### 참가자 본인 출석 등록 페이지 (`index.html`, `app.js`)
- 본인 1명 전용 출석 폼 (참가자 추가 버튼 없음).
- URL 파라미터(`?code=gjyouth-XXXXXX`)로 프로그램 정보 조회 (일시/강사명만 깔끔하게 표시, 제한 배지 미표시).
- 출석일자는 접속 시점의 시스템 현지 날짜(`YYYY/MM/DD`)로 자동 고정.
- **대리 출석 방지 (1기기 1회 제출 차단)**:
  - 접속 시 `localStorage`와 `IndexedDB`에 영구 기기 식별자(`gjyouth_device_id`, UUID v4) 자동 생성·동기화 및 환경/하드웨어 기반 보조 지문(`deviceFingerprint`) 생성.
  - 동일 기기로 동일 프로그램·동일 출석일자에 이미 출석한 경우 재접속 시 폼을 숨기고 `"이미 이 기기에서 출석 등록이 완료되었습니다."` 안내 화면 즉시 표시.
- 이름(공백 제거 후 한글 2~5자, 3회 연속 반복 금지, 블랙리스트 차단), 생년월일 드롭다운(윤년/말일 자동 보정), 성별(`[남]`/`[여]`), 개인정보 수집·이용 동의 검증.
- 출석부 명단이 존재하는 경우 `이름 + 생년월일 + 성별` 정확 일치 대조, 불일치 시 `"출석부에 등록되어있지 않은 정보입니다."` 표시 후 차단.
- 제출 성공 시 `"출석이 완료되었습니다 :)"` 완료 화면과 프로그램명·출석일자·참가자명 요약 표시.

---

## 3. Google Sheets & Google Apps Script 연동 가이드

### Step 1. Google Sheets 생성
1. [Google Sheets](https://sheets.google.com)에서 새 스프레드시트를 생성합니다.
2. 별도로 시트를 만들지 않아도 첫 요청 시 아래 2개 시트가 1행 헤더와 함께 자동 생성됩니다.

#### 시트 1: `프로그램목록`
| 생성일시 | 프로그램코드 | 프로그램명 | 프로그램일자 | 프로그램시간 | 강사명 | 출석부명단 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-20 14:00:00 | gjyouth-8A3K92 | 청년 재테크 특강 | 2026-11-24 | 14:00 ~ 16:00 | 김청년 | `[{"name":"강하늘","birthDate":"1998-03-15","gender":"남"}]` |

#### 시트 2: `참가자명단`
| 등록날짜 | 등록시간 | 프로그램코드 | 프로그램명 | 출석일자 | 참가자명 | 생년월일 | 연령구분 | 성별 | 개인정보동의 | 기기ID |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-20 | 14:05:12 | gjyouth-8A3K92 | 청년 재테크 특강 | 2026/11/20 | 강하늘 | 1998-03-15 | 청년 | 남 | 동의함 | `uuid::fp_...` |

- **동시성 제어**: `LockService.getScriptLock()` 적용.
- **등록날짜 / 등록시간**: 한국 표준시(`Asia/Seoul`) 기준 `yyyy-MM-dd`, `HH:mm:ss` 별도 열 기록.
- **연도별 청년 연령 자동 계산 (하드코딩 없음)**:
  - 등록 연도(`currentYear`) 기준 `currentYear - 39` 이상 `currentYear - 19` 이하(연 나이 19세~39세)이면 `청년`, 그 외는 `청년외`로 자동 기록.
  - 예: 2026년 → 1987~2007년생 `청년` / 2027년 → 1988~2008년생 `청년`.
- **중복 출석 및 대리 출석 차단**: 같은 `프로그램코드 + 출석일자` 내에서
  1. 동일한 `기기ID` 또는 `deviceFingerprint` 재제출 시 `"이미 이 기기에서 출석 등록이 완료되었습니다."` 반환
  2. 동일한 `참가자명 + 생년월일` 중복 제출 시 `"이미 출석 처리가 완료된 참가자입니다."` 반환

### Step 2. Google Apps Script 코드 붙여넣기 및 배포
1. 스프레드시트 상단 메뉴 **확장 프로그램 → Apps Script** 클릭.
2. `apps-script/Code.gs` 내용을 복사해 붙여넣고 저장합니다.
3. (선택) 기본 관리자 비밀번호(`1234`)를 변경하려면 좌측 **프로젝트 설정 → 스크립트 속성**에 `ADMIN_PASSWORD` 속성을 추가합니다.
4. 우측 상단 **배포 → 새 배포 → 웹 앱** 선택:
   - **다음 사용자 권한으로 실행**: `나(본인 계정)`
   - **액세스 권한이 있는 사용자**: `모든 사용자`
5. 배포 후 발급된 **웹 앱 URL**(`https://script.google.com/macros/s/.../exec`)을 복사합니다.

### Step 3. 프론트엔드 연결 및 GitHub Pages 배포
- **로컬 테스트 모드 (`IS_TEST_MODE = true`)**:
  - `config.js`가 없거나 `IS_TEST_MODE: true`로 설정하면 GAS 연동 없이 브라우저 `localStorage` / `IndexedDB`로 전체 흐름을 즉시 테스트할 수 있습니다.
- **실연동 모드 (`IS_TEST_MODE = false`)**:
  - 로컬 실행 시 `config.example.js`를 `config.js`로 복사해 `IS_TEST_MODE: false`와 `GAS_WEB_APP_URL`을 입력합니다.
  - GitHub Pages 배포 시 저장소 **Settings → Secrets and variables → Actions**에 `GAS_WEB_APP_URL`을 등록하고 `main` 브랜치에 푸시하면 자동 배포됩니다.
- 접속 주소:
  - 관리자 페이지: `https://<아이디>.github.io/<저장소명>/admin.html`
  - 참가자 출석 페이지: `https://<아이디>.github.io/<저장소명>/index.html?code=gjyouth-XXXXXX`
