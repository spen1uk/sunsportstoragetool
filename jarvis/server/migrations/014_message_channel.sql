-- Which device/interface a message came from, so one continuous conversation can be shared by the dashboard, phone, car, text and voice later.
ALTER TABLE messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'dashboard';
