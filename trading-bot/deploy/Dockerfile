FROM python:3.12-slim
WORKDIR /app
COPY . /app
# Only needed if you turn on claude_review in config.json
RUN pip install --no-cache-dir -r requirements.txt
ENV PYTHONUNBUFFERED=1
VOLUME ["/app/data"]
CMD ["python", "run.py", "run"]
