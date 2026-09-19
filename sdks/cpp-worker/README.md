# tenvyr-worker (C++)

Private C++17 HTTP worker for Tenvyr protocol v1. See
`docs/architecture/workers/cpp-worker.md`.

```bash
cmake -S sdks/cpp-worker -B sdks/cpp-worker/build -DCMAKE_CXX_COMPILER=g++
cmake --build sdks/cpp-worker/build
ctest --test-dir sdks/cpp-worker/build --output-on-failure
```
