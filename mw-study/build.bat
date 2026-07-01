@echo off
REM Always run from the directory containing this script, regardless of where it was launched
cd /d "%~dp0"
echo === Building MotiveWave Studies ===
echo Working directory: %CD%

REM ── Find JDK ──────────────────────────────────────────────────────────────────
set "JAVAC="
set "JAR_TOOL="

REM Prefer JDK 26 (matches the MW SDK's Java-26 class files exactly — no version warning).
for /d %%d in ("C:\Program Files\Eclipse Adoptium\jdk-26*" "C:\Program Files\Java\jdk-26*") do (
    if exist "%%d\bin\javac.exe" (
        set "JAVAC=%%d\bin\javac.exe"
        set "JAR_TOOL=%%d\bin\jar.exe"
    )
)
REM JDK 25 also compiles against the v70 SDK (emits a harmless "major version 70" warning).
for /d %%d in ("C:\Program Files\Eclipse Adoptium\jdk-25*" "C:\Program Files\Java\jdk-25*") do (
    if not defined JAVAC (
        if exist "%%d\bin\javac.exe" (
            set "JAVAC=%%d\bin\javac.exe"
            set "JAR_TOOL=%%d\bin\jar.exe"
        )
    )
)
for /d %%d in ("C:\Program Files\Eclipse Adoptium\jdk-21*" "C:\Program Files\Java\jdk-21*") do (
    if not defined JAVAC (
        if exist "%%d\bin\javac.exe" (
            set "JAVAC=%%d\bin\javac.exe"
            set "JAR_TOOL=%%d\bin\jar.exe"
        )
    )
)
for /d %%d in ("C:\Program Files\Eclipse Adoptium\jdk-17*" "C:\Program Files\Java\jdk-17*") do (
    if not defined JAVAC (
        if exist "%%d\bin\javac.exe" (
            set "JAVAC=%%d\bin\javac.exe"
            set "JAR_TOOL=%%d\bin\jar.exe"
        )
    )
)
if not defined JAVAC (
    where javac >nul 2>&1
    if not errorlevel 1 (
        set "JAVAC=javac"
        set "JAR_TOOL=jar"
    )
)
if not defined JAVAC goto NO_JDK
echo JDK: %JAVAC%
goto JDK_OK
:NO_JDK
echo ERROR: No JDK found. Install JDK 17+ from https://adoptium.net
pause
exit /b 1
:JDK_OK

REM ── Verify source files exist ──────────────────────────────────────────────
if not exist "com\custom\LiveBarRelay.java" (
    echo ERROR: com\custom\LiveBarRelay.java not found.
    echo Make sure you are running this from the mw-study folder.
    echo Current dir: %CD%
    pause & exit /b 1
)

REM ── MotiveWave SDK ────────────────────────────────────────────────────────────
set "SDK=C:\Program Files (x86)\MotiveWave\lib\mwave_sdk.jar"
if exist "%SDK%" goto SDK_OK
echo ERROR: MotiveWave SDK not found at:
echo   %SDK%
echo Make sure MotiveWave is installed.
pause
exit /b 1
:SDK_OK

set "OUT=%~dp0out"
set "DEST=%USERPROFILE%\MotiveWave Extensions"

if exist "%OUT%" rmdir /s /q "%OUT%"

REM ══════════════════════════════════════════════════════════════════════════════
REM  1. LiveBarRelay
REM ══════════════════════════════════════════════════════════════════════════════
echo.
echo --- Building LiveBarRelay.jar ---
mkdir "%OUT%"

REM Compile LiveBarRelay ALONE. Do NOT bundle HistoryDumper here — it is built as its own jar
REM below. Bundling it caused com.custom.HistoryDumper to live in TWO jars, so MotiveWave saw the
REM HISTORY_DUMPER study id twice and dropped it from the Add-Study list (the duplicate-load bug).
"%JAVAC%" --release 17 -cp "%SDK%" -d "%OUT%" "com\custom\LiveBarRelay.java"
if errorlevel 1 goto FAIL_LBR

if exist "LiveBarRelay.jar" del "LiveBarRelay.jar"
"%JAR_TOOL%" cf "LiveBarRelay.jar" -C "%OUT%" .
if errorlevel 1 goto FAIL_LBR_JAR
echo LiveBarRelay.jar built OK (contains LiveBarRelay + HistoryDumper)
goto BUILD_AT

:FAIL_LBR
echo COMPILE FAILED: LiveBarRelay or HistoryDumper
pause & exit /b 1
:FAIL_LBR_JAR
echo JAR FAILED: LiveBarRelay
pause & exit /b 1

REM ══════════════════════════════════════════════════════════════════════════════
REM  2. AutoTrader
REM ══════════════════════════════════════════════════════════════════════════════
:BUILD_AT
echo.
echo --- Building AutoTrader.jar ---
rmdir /s /q "%OUT%"
mkdir "%OUT%"

"%JAVAC%" --release 17 -cp "%SDK%" -d "%OUT%" "com\custom\AutoTrader.java"
if errorlevel 1 goto FAIL_AT

if exist "AutoTrader.jar" del "AutoTrader.jar"
"%JAR_TOOL%" cf "AutoTrader.jar" -C "%OUT%" .
if errorlevel 1 goto FAIL_AT_JAR
echo AutoTrader.jar built OK
goto BUILD_HD

:FAIL_AT
echo COMPILE FAILED: AutoTrader
pause & exit /b 1
:FAIL_AT_JAR
echo JAR FAILED: AutoTrader
pause & exit /b 1

REM ══════════════════════════════════════════════════════════════════════════════
REM  3. HistoryDumper
REM ══════════════════════════════════════════════════════════════════════════════
:BUILD_HD
echo.
echo --- Building HistoryDumper.jar ---
rmdir /s /q "%OUT%"
mkdir "%OUT%"

"%JAVAC%" --release 17 -cp "%SDK%" -d "%OUT%" "com\custom\HistoryDumper.java"
if errorlevel 1 goto FAIL_HD

if exist "HistoryDumper.jar" del "HistoryDumper.jar"
"%JAR_TOOL%" cf "HistoryDumper.jar" -C "%OUT%" .
if errorlevel 1 goto FAIL_HD_JAR
echo HistoryDumper.jar built OK
goto COPY_JARS

:FAIL_HD
echo COMPILE FAILED: HistoryDumper
pause & exit /b 1
:FAIL_HD_JAR
echo JAR FAILED: HistoryDumper
pause & exit /b 1

REM ══════════════════════════════════════════════════════════════════════════════
REM  Auto-copy JARs to MotiveWave Extensions
REM ══════════════════════════════════════════════════════════════════════════════
:COPY_JARS
echo.
echo --- Copying JARs to MotiveWave Extensions ---
if not exist "%DEST%" mkdir "%DEST%"
copy /y "LiveBarRelay.jar"  "%DEST%\LiveBarRelay.jar"
copy /y "AutoTrader.jar"    "%DEST%\AutoTrader.jar"
copy /y "HistoryDumper.jar" "%DEST%\HistoryDumper.jar"
echo Copied to: %DEST%

echo.
echo === SUCCESS: All JARs built and installed ===
echo.
echo NOW: Restart MotiveWave completely (File ^> Exit, then reopen).
echo After restart, right-click your MES chart ^> Add Study:
echo   Search "Live Bar Relay"   ^> double-click ^> OK
echo   Search "History Dumper"   ^> double-click ^> OK  (writes CSV to disk)
echo   Search "Auto Trader"      ^> double-click ^> OK
echo.
pause
