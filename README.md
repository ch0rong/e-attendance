# 찾아가는 청년센터 - 프로그램 참가자 출석 등록 시스템

별도 프레임워크 없이 순수 **HTML, CSS, Vanilla JS**로 구축된 프로그램 출석 등록 웹 애플리케이션입니다.  
**GitHub Pages**에 바로 배포할 수 있으며, 백엔드 데이터베이스로 **Google Apps Script + Google Sheets**를 사용합니다.

---

## 1. 폴더 구조

```text
e-attendance/
├── index.html              # 참가자 출석 등록 페이지 (?code=gjyouth-XXXXXX)
├── admin.html              # 관리자용 프로그램 생성 및 링크 발급 페이지
├── style.css               # 공통 스타일시트 (반응형 + @font-face 선언)
├── app.js                  # 참가자 출석 등록 페이지 로직
├── admin.js                # 관리자 페이지 로직
├── apps-script/
│   └── Code.gs             # Google Sheets 연동 백엔드 (Google Apps Script)
├── assets/
│   ├── images/             # 로고 이미지 폴더 (logo.png 배치)
│   └── fonts/              # 커스텀 폰트 폴더 (NEXONFootballGothicL / B 배치)
└── README.md               # 설치 및 배포 가이드
```

---

## 2. 로컬 테스트 방법 (GAS 연동 전 바로 확인하기)

초기 설정은 `admin.js`와 `app.js` 모두 `IS_TEST_MODE = true`로 되어 있어, Google Apps Script를 연결하지 않고도 브라우저 `localStorage`를 이용해 전체 흐름을 즉시 테스트할 수 있습니다.

1. 프로젝트 폴더를 로컬 웹 서버로 실행합니다. (예: VS Code Live Server 또는 `npx serve .` / `python -m http.server 8000`)
2. 브라우저에서 `admin.html`에 접속합니다.
3. 기본 관리자 비밀번호 `1234`를 입력합니다.
4. 새 프로그램을 생성합니다. (사전 신청자 명단을 입력하거나 비워둘 수 있음)
5. 생성된 전용 링크(`index.html?code=gjyouth-XXXXXX`)를 복사하거나 **출석 페이지 열기**를 클릭합니다.
6. 참가자 출석 등록 화면에서 아래 시나리오를 테스트할 수 있습니다.
   - 잘못된 이름(영문, 숫자, 자음/모음, 3회 반복, 블랙리스트) 차단
   - 사전 신청 명단 미포함 이름 차단
   - 생년월일 6자리 숫자 전용 입력(`YYMMDD`, 예: `950213`) 및 윤년/존재 날짜 검증
   - 개인정보 미동의 시 차단
   - 동일 조건(프로그램코드 + 출석일자 + 참가자명 + 생년월일) 중복 출석 차단
   - 출석 완료 화면 및 요약 카드 표시

---

## 3. 로고 · 폰트 · 관리자 비밀번호 설정

### 로고 이미지
- `assets/images/logo.png` 경로에 로고 파일을 넣으면 상단 헤더에 자동 표시됩니다.
- 파일이 없을 경우 깨진 이미지가 보이지 않도록 `onerror="this.style.display='none'"` 처리되어 있습니다.

### 커스텀 폰트 (`NEXON Football Gothic`)
- `assets/fonts/` 폴더에 아래 파일명으로 폰트를 배치해 두었습니다.
  - Light (weight `300`): `NEXON Football Gothic L.otf`
  - Bold (weight `700`): `NEXON Football Gothic B.otf`
- 폰트 파일이 없을 때는 시스템 기본 산세리프(`Pretendard`, `Malgun Gothic`, `sans-serif`)로 깔끔하게 표시됩니다.

### 보안 설계 (GitHub 공개 저장소 보호)
- **관리자 비밀번호 비노출**: 실제 비밀번호는 GitHub 코드에 포함되지 않으며, Google Apps Script의 **프로젝트 설정 → 스크립트 속성(`ADMIN_PASSWORD`)**에만 저장되어 서버 측에서 검증합니다.
- **GAS 웹 앱 URL 비노출**: 로컬 `config.js`는 `.gitignore`로 GitHub 업로드를 차단하며, GitHub Pages 배포 시에는 **GitHub Repository Secrets(`GAS_WEB_APP_URL`)**에서 GitHub Actions가 자동 주입합니다.
- **참가자 개인정보 비노출**: 참가자 페이지의 프로그램 조회(`getProgram`)는 사전신청자 명단(이름·생년월일·성별)을 브라우저로 내려보내지 않고, 제출 시 Google Apps Script 서버 내부에서만 대조합니다.
- **관리자 API 보호**: 프로그램 목록 조회(`listPrograms`) 및 생성/수정/삭제는 모두 서버 비밀번호 인증(`adminPassword`) 없이는 호출할 수 없습니다.

---

## 4. Google Sheets & Google Apps Script 연동 가이드

### Step 1. Google Sheets 생성
1. [Google Sheets](https://sheets.google.com)에서 새 스프레드시트를 생성합니다. (예: `찾아가는 청년센터 출석관리`)
2. 별도로 시트를 미리 만들지 않아도 첫 요청 시 `프로그램목록`과 `참가자명단` 시트가 1행 헤더와 함께 자동 생성됩니다.

### Step 2. Google Apps Script 코드 붙여넣기 & 관리자 비밀번호 등록
1. 스프레드시트 상단 메뉴에서 **확장 프로그램 → Apps Script**를 클릭합니다.
2. 기본 `Code.gs` 내용을 모두 지우고, 이 프로젝트의 `apps-script/Code.gs` 파일 내용을 그대로 붙여넣은 뒤 저장(`Ctrl + S`)합니다.
3. 좌측 톱니바퀴(**프로젝트 설정**) → 하단 **스크립트 속성 → 스크립트 속성 추가**를 클릭합니다.
   - **속성**: `ADMIN_PASSWORD`
   - **값**: 사용하실 관리자 비밀번호 (예: 본인이 정한 비밀번호)
   - **스크립트 속성 저장** 클릭

### Step 3. 웹 앱 배포
1. Apps Script 편집기 우측 상단의 **배포 → 새 배포**를 클릭합니다.
2. 유형 선택(톱니바퀴 아이콘)에서 **웹 앱**을 선택합니다.
3. 아래와 같이 설정합니다.
   - **설명**: `찾아가는 청년센터 출석 API v1`
   - **다음 사용자 권한으로 실행**: `나(본인 계정)`
   - **액세스 권한이 있는 사용자**: `모든 사용자`
4. **배포**를 클릭하고 권한 승인 절차를 진행합니다.
   > *"Google에서 확인하지 않은 앱"* 경고가 나타나면 **고급 → 프로젝트명(안전하지 않음)으로 이동 → 허용**을 선택하세요.
5. 발급된 **웹 앱 URL**(`https://script.google.com/macros/s/.../exec`)을 복사합니다.

### Step 4. URL 연결 (GitHub Secrets 또는 로컬 `config.js`)
- **GitHub Pages 배포 시**: 저장소 **Settings → Secrets and variables → Actions → New repository secret**에 `GAS_WEB_APP_URL`로 등록하면 `.github/workflows/deploy.yml`이 배포 시 자동 주입합니다.
- **로컬 테스트 시**: `config.example.js`를 `config.js`로 복사해 `IS_TEST_MODE: false`와 `GAS_WEB_APP_URL`을 입력합니다. (`config.js`는 `.gitignore`에 포함되어 GitHub에 올라가지 않습니다.)

> **참고:** `Code.gs`를 수정한 경우 반드시 **배포 → 배포 관리 → 수정(연필 아이콘) → 새 버전**으로 다시 배포해야 변경사항이 반영됩니다.

---

## 5. Google Sheets 데이터 구조 및 자동화 규칙

### 시트 1: `프로그램목록`
| 생성일시 | 프로그램코드 | 프로그램명 | 프로그램일자 | 프로그램시간 | 강사명 | 사전신청명단 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-19 15:30:00 | gjyouth-8A3K92 | 청년 재테크 특강 | 2026-11-24, 2026-11-26, 2026-12-01 | 오후 2:00 ~ 오후 4:00 | 김청년 | `[{"name":"이서연","birthDate":"2000-05-09","gender":"여성"}]` |

- **다회기 프로그램 지원**: 관리자 페이지 달력에서 여러 날짜를 클릭하거나 요일 헤더(일~토)를 클릭해 요일별 복수 일자를 선택할 수 있으며, 쉼표(`, `)로 구분되어 저장됩니다.
- **시간 드롭다운**: 시작/종료 시간을 `오전/오후 · 1~12시 · 00/30분` 드롭다운으로 선택하며, 종료 시간은 시작 시간 이후의 슬롯만 자동으로 노출됩니다.
- **사전 신청자 구조화 대조**: 이름·생년월일·성별을 등록하면 참가자가 입력한 3개 항목이 모두 일치해야 출석이 가능합니다. 비워두면 **현장 자유 참여 모드**로 작동합니다.
- **프로그램 수정 기능**: 생성된 프로그램 목록에서 **[수정]** 버튼으로 프로그램 정보를 수정할 수 있으며, 수정 내용은 저장 이후 신규 출석부터 반영되고 기존 `참가자명단` 출석 기록은 변경되지 않습니다.

### 시트 2: `참가자명단`
| 등록날짜 | 등록시간 | 프로그램코드 | 프로그램명 | 출석일자 | 참가자명 | 생년월일 | 연령구분 | 성별 | 개인정보동의 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-19 | 15:42:10 | gjyouth-8A3K92 | 청년 재테크 특강 | 2026/11/19 | 이서연 | 2000-05-09 | 청년 | 여성 | 동의함 |

- **등록날짜 / 등록시간**: 한국 표준시(`Asia/Seoul`) 기준으로 각각 `yyyy-MM-dd`, `HH:mm:ss`로 분리 기록
- **프로그램 운영 일자 서버 검증(KST)**: 브라우저가 보낸 날짜를 신뢰하지 않고 Google Apps Script 서버의 실제 한국 시간(`Asia/Seoul`)이 설정된 `프로그램일자`와 일치할 때만 출석을 허용하며, 일치하지 않으면 `"현재 출석 등록 가능일이 아닙니다."`로 차단
- **연령구분 자동 판별**:
  - 출생연도 **1987 ~ 2007** → `청년`
  - 출생연도 **1986 이하 또는 2008 이상** → `청년외`
- **중복 출석 차단**: 동일한 `프로그램코드 + 출석일자 + 참가자명 + 생년월일` 조합은 중복 등록 차단
- **오늘의 1등 이벤트**: 해당 프로그램의 당일 첫 번째 출석 등록 완료자에게 완료 화면에 **"🏆 오늘의 1등!!!"** 배너 표시
- **동시성 제어**: `LockService.getScriptLock()`을 적용하여 다수 참가자의 동시 제출 시 데이터 충돌 및 1등 중복 판정 방지

---

## 6. Cloudflare Pages Free 배포 방법 (GitHub Private 저장소 유지)

GitHub 저장소를 **Private**으로 유지한 채 **Cloudflare Pages 무료 플랜**으로 자동 배포할 수 있습니다.

1. [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages → Create → Pages → Connect to Git**에서 Private 저장소를 연결합니다.
2. 빌드 설정을 아래와 같이 입력합니다.
   - **Production branch**: `main`
   - **Build command**: `node scripts/build-pages.js`
   - **Build output directory**: `dist`
3. **Environment variables (환경 변수)**에 아래 값을 추가합니다.
   - 변수명: `GAS_WEB_APP_URL`
   - 값: Google Apps Script 웹 앱 URL
4. **Save and Deploy** 클릭 시 `dist/`에 프론트엔드 파일만 안전하게 빌드되어 배포됩니다. (`apps-script/`, `scripts/`, `README.md` 등은 공개 배포에서 제외)
5. 배포 완료 후 발급된 `https://<프로젝트명>.pages.dev` 주소로 접속할 수 있습니다.
   - 관리자 페이지: `https://<프로젝트명>.pages.dev/admin.html`
   - 참가자 출석 페이지: `https://<프로젝트명>.pages.dev/index.html?code=gjyouth-XXXXXX`
