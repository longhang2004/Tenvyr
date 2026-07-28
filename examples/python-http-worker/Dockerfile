FROM python:3.13-slim

WORKDIR /app
COPY sdks/python-worker ./sdks/python-worker
RUN python -m pip install --no-cache-dir ./sdks/python-worker
COPY examples/python-http-worker/src/main.py ./main.py

EXPOSE 8080
CMD ["python", "main.py"]
