FROM python:3.11-slim

# הגדרת תיקיית העבודה הראשית
WORKDIR /src

# מניעת יצירת קובצי .pyc ושיפור הלוגים
ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1

# התקנת תלויות מערכת
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# העתקה והתקנה של דרישות
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# הקסם קורה כאן: מעתיקים את תיקיית app המקומית לתוך תיקיית app בקונטיינר
# ומוודאים שאנחנו נמצאים בתיקייה שמעליה (שורש הפרויקט)
COPY ./app ./app

# פקודה להרצת הבוט מתוך שורש הפרויקט
CMD ["python", "-m", "app.main"]