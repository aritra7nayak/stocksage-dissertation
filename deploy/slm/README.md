# StockSage small language model (Module D)

The assistant's language model runs locally in [llama.cpp](https://github.com/ggml-org/llama.cpp)'s
`llama-server`, which exposes an OpenAI-compatible API with tool calling. Everything here is free
and runs offline.

## Setup (once)

Files live outside the repository, in `%USERPROFILE%\slm`:

| Item | Source | Size |
|---|---|---|
| `llama.cpp\` | llama.cpp release **b12627**: `llama-b12627-bin-win-cuda-12.4-x64.zip` + `cudart-llama-bin-win-cuda-12.4-x64.zip` | ~0.6 GB |
| `models\Qwen3.5-2B-Q4_K_M.gguf` | `unsloth/Qwen3.5-2B-GGUF` (base model `Qwen/Qwen3.5-2B`, Apache 2.0) | 1.3 GB |
| `models\Qwen3.5-4B-Q4_K_M.gguf` | `unsloth/Qwen3.5-4B-GGUF` (base model `Qwen/Qwen3.5-4B`, Apache 2.0) | 2.7 GB |

## Run

```powershell
deploy\slm\start-slm.bat                                   # 2B, fully on the GPU
deploy\slm\start-slm.bat Qwen3.5-4B-Q4_K_M.gguf 24         # 4B, partly on the GPU
```

The backend talks to it through `ASSISTANT_LLM_URL` (default `http://127.0.0.1:8081/v1`) and
`ASSISTANT_MODEL` (default `stocksage-slm`, the alias set by the script). Check it with
`GET /api/assistant/status`, then ask questions with `POST /api/assistant/chat`.

The fine-tuned StockSage model replaces the base GGUF file once trained (Module D, step 6).
