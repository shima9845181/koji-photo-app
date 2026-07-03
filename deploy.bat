@echo off
chcp 65001 >nul
setlocal
rem ============================================================
rem  工事写真管理アプリ  ---  GitHub 公開サイトへ反映（デプロイ）
rem  このファイルをダブルクリックすると、フォルダの内容を
rem  GitHub(koji-photo-app) へ push し、公開サイトを更新します。
rem  ブラウザの「アプリを更新して公開」ボタンの確実な代替です。
rem ============================================================

set "GIT=C:\Program Files\Git\cmd\git.exe"
if not exist "%GIT%" set "GIT=git"

cd /d "%~dp0"

echo.
echo === 変更をGitHubへ反映します ===
echo フォルダ: %cd%
echo.

"%GIT%" add -A
if errorlevel 1 goto err

rem コミット（日時付き）。変更が無い場合はスキップ扱い。
for /f "tokens=1-5 delims=/: " %%a in ("%date% %time%") do set "STAMP=%%a-%%b-%%c %%d:%%e"
"%GIT%" commit -m "アプリ更新 %STAMP%"
if errorlevel 1 (
  echo.
  echo 反映する変更がありませんでした（またはコミットをスキップしました）。
)

echo.
echo === push 中 ===
"%GIT%" push
if errorlevel 1 goto err

echo.
echo ============================================================
echo  完了しました。数分で公開サイトに反映されます:
echo  https://shima9845181.github.io/koji-photo-app/
echo ============================================================
echo.
pause
exit /b 0

:err
echo.
echo *** エラーが発生しました。上の表示をご確認ください。 ***
echo （初回や認証切れの場合、GitHubのログインを求められることがあります）
echo.
pause
exit /b 1
