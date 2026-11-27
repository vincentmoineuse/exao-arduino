@echo off
rem ==================================================================
rem  EXAO Arduino - lancement depuis la cle USB (sans reseau)
rem  Laboratoire de physique chimie du lycee du Hainaut
rem  Ouvre l'appli en fenetre "application" avec Chrome, sinon Edge.
rem  Les reglages (etalonnages, noms des sondes) sont gardes sur la cle.
rem ==================================================================
setlocal
set "DOSSIER=%~dp0"
set "PAGE=%DOSSIER%app\index.html"
if not exist "%PAGE%" (
  echo Fichier introuvable : "%PAGE%"
  echo Le dossier "app" doit etre a cote de ce fichier.
  pause
  exit /b 1
)
set "URL=file:///%PAGE:\=/%"
set "PROFIL=%DOSSIER%app\profil-navigateur"

set "NAV="
for %%N in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do if not defined NAV if exist %%N set "NAV=%%~N"

if not defined NAV (
  echo Ni Chrome ni Edge n'ont ete trouves sur ce PC.
  echo Ouvrez le fichier app\index.html avec Chrome ou Edge.
  pause
  exit /b 1
)
start "" "%NAV%" --app="%URL%" --user-data-dir="%PROFIL%" --no-first-run --no-default-browser-check
endlocal
