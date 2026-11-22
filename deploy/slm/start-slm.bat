@echo off
REM Start the StockSage small language model (llama.cpp llama-server) on http://127.0.0.1:8081
REM Usage: start-slm.bat [model-file] [gpu-layers]
REM   start-slm.bat                                    -> 2B model, fully on the GPU
REM   start-slm.bat Qwen3.5-4B-Q4_K_M.gguf 24          -> 4B model, 24 layers on the GPU, rest on the CPU
setlocal
set SLM_HOME=%USERPROFILE%\slm
set MODEL=%~1
if "%MODEL%"=="" set MODEL=Qwen3.5-2B-Q4_K_M.gguf
set NGL=%~2
if "%NGL%"=="" set NGL=99

if not exist "%SLM_HOME%\llama.cpp\llama-server.exe" (
  echo llama.cpp not found in %SLM_HOME%\llama.cpp - see deploy\slm\README.md
  exit /b 1
)
if not exist "%SLM_HOME%\models\%MODEL%" (
  echo Model %MODEL% not found in %SLM_HOME%\models - see deploy\slm\README.md
  exit /b 1
)
echo Starting %MODEL% with %NGL% GPU layers on http://127.0.0.1:8081 ...
"%SLM_HOME%\llama.cpp\llama-server.exe" -m "%SLM_HOME%\models\%MODEL%" --alias stocksage-slm ^
  --host 127.0.0.1 --port 8081 -c 8192 -np 1 -ngl %NGL% -fa on --jinja --temp 0.3
REM -np 1: one chat slot. The default (4 slots) reserves memory for 4 x 8192 tokens,
REM which on a 4 GB GPU pushes model layers back to the CPU and makes prompts ~3x slower.
