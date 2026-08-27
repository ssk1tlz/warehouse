"""
Warehouse App - System Tray Application
Запускает сервер и показывает иконку в трее
"""
import sys
import subprocess
import webbrowser
import socket
import json
from datetime import datetime
from pathlib import Path
from threading import Thread
import os

try:
    from PyQt5.QtWidgets import QApplication, QSystemTrayIcon, QMenu, QAction
    from PyQt5.QtGui import QIcon
    from PyQt5.QtCore import QTimer
except ImportError:
    print("PyQt5 не установлен. Устанавливаю зафиксированные версии из requirements.txt...")
    _requirements = Path(__file__).resolve().parent / "requirements.txt"
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", str(_requirements)])
    from PyQt5.QtWidgets import QApplication, QSystemTrayIcon, QMenu, QAction
    from PyQt5.QtGui import QIcon
    from PyQt5.QtCore import QTimer

# Определяем пути
if getattr(sys, 'frozen', False):
    # Если запущен как exe
    ROOT = Path(sys.executable).resolve().parent
else:
    # Если запущен как скрипт
    ROOT = Path(__file__).resolve().parent

SERVER_SCRIPT = ROOT / "server.py"
CONFIG_FILE = ROOT / "config.json"


def _load_port() -> int:
    try:
        return int(json.loads(CONFIG_FILE.read_text(encoding="utf-8")).get("port", 8765))
    except Exception:
        return 8765


# Браузер и проверки порта всегда через loopback — сервер работает на этой же машине.
# Хост, на котором сервер слушает (127.0.0.1 или 0.0.0.0), задается в config.json
# и читается самим server.py.
HOST = "127.0.0.1"
PORT = _load_port()
URL = f"http://{HOST}:{PORT}/"
LOCK_FILE = ROOT / ".warehouse_app.lock"


class WarehouseApp:
    def __init__(self):
        self.app = QApplication(sys.argv)
        self.app.setQuitOnLastWindowClosed(False)
        
        # Проверка на единственный экземпляр через файл блокировки.
        # Если порт занят — экземпляр действительно работает: открываем браузер и выходим.
        # Если порт свободен — lock-файл устарел (приложение упало/закрылось некорректно),
        # удаляем его и запускаемся как обычно.
        if LOCK_FILE.exists():
            if self.is_port_in_use(PORT):
                print("Приложение уже запущено!")
                webbrowser.open(URL)
                sys.exit(0)
            print("Обнаружен устаревший lock-файл — удаляю и продолжаю запуск.")
            try:
                LOCK_FILE.unlink()
            except Exception as e:
                print(f"Не удалось удалить устаревший lock-файл: {e}")
        
        # Создаем файл блокировки
        try:
            LOCK_FILE.write_text(str(os.getpid()))
        except Exception as e:
            print(f"Не удалось создать файл блокировки: {e}")
        
        self.httpd = None
        self.server_thread = None
        self.is_server_running = False
        
        # Создаем иконку в трее
        self.tray_icon = QSystemTrayIcon(self.app)
        self.setup_tray_icon()
        
        # Запускаем сервер
        self.start_server()
        
        # Таймер для проверки статуса сервера
        self.status_timer = QTimer()
        self.status_timer.timeout.connect(self.check_server_status)
        self.status_timer.start(2000)  # Проверка каждые 2 секунды
        
    def setup_tray_icon(self):
        """Настройка иконки в трее и меню"""
        # Используем стандартную иконку (можно заменить на свою)
        icon = self.app.style().standardIcon(self.app.style().SP_ComputerIcon)
        self.tray_icon.setIcon(icon)
        self.tray_icon.setToolTip("Склад IT-техники")
        
        # Создаем меню
        menu = QMenu()
        
        # Действие: Открыть приложение
        open_action = QAction("Открыть приложение", self.app)
        open_action.triggered.connect(self.open_browser)
        menu.addAction(open_action)
        
        menu.addSeparator()
        
        # Действие: Статус сервера
        self.status_action = QAction("Статус: Запуск...", self.app)
        self.status_action.setEnabled(False)
        menu.addAction(self.status_action)
        
        menu.addSeparator()
        
        # Действие: Перезапустить сервер
        restart_action = QAction("Перезапустить сервер", self.app)
        restart_action.triggered.connect(self.restart_server)
        menu.addAction(restart_action)
        
        menu.addSeparator()
        
        # Действие: Выход
        quit_action = QAction("Выход", self.app)
        quit_action.triggered.connect(self.quit_app)
        menu.addAction(quit_action)
        
        self.tray_icon.setContextMenu(menu)
        
        # Двойной клик по иконке открывает браузер
        self.tray_icon.activated.connect(self.on_tray_icon_activated)
        
        self.tray_icon.show()
        
    def on_tray_icon_activated(self, reason):
        """Обработка клика по иконке в трее"""
        if reason == QSystemTrayIcon.DoubleClick:
            self.open_browser()
            
    def is_port_in_use(self, port):
        """Проверка, занят ли порт"""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                return s.connect_ex(('127.0.0.1', port)) == 0
        except:
            return False
            
    def start_server(self):
        """Запуск сервера"""
        if self.is_port_in_use(PORT):
            print(f"Порт {PORT} уже занят. Возможно, сервер уже запущен.")
            self.is_server_running = True
            self.status_action.setText(f"Статус: Работает (порт {PORT})")
            self.tray_icon.showMessage(
                "Склад IT-техники",
                "Сервер уже запущен",
                QSystemTrayIcon.Information,
                2000
            )
            # Открываем браузер
            QTimer.singleShot(500, self.open_browser)
            return
            
        try:
            print(f"Запуск сервера...")
            # Создаем HTTP-сервер сами, чтобы корректно останавливать его при выходе
            import server
            server.init_db()
            self.clear_startup_error()
            # server.HOST берется из config.json (127.0.0.1 или 0.0.0.0 для сети)
            self.httpd = server.ThreadingHTTPServer((server.HOST, server.PORT), server.WarehouseHandler)

            def run_server():
                try:
                    self.httpd.serve_forever()
                except Exception as e:
                    print(f"Ошибка сервера: {e}")

            self.server_thread = Thread(target=run_server, daemon=True)
            self.server_thread.start()

            print("Сервер запущен в фоновом потоке")

            # Ждем запуска сервера
            self.wait_for_server_start()

        except Exception as e:
            print(f"Ошибка запуска сервера: {e}")
            self.httpd = None
            # Всплывающее уведомление в трее легко пропустить (а в некоторых
            # окружениях оно вообще не появляется), поэтому длинное сообщение о
            # повреждённой базе дополнительно сохраняем в файл рядом с копиями.
            self.write_startup_error(e)
            self.tray_icon.showMessage(
                "Ошибка",
                f"Не удалось запустить сервер: {e}",
                QSystemTrayIcon.Critical,
                5000
            )

    def _startup_error_file(self):
        import server
        return server.BACKUP_DIR / "ОШИБКА_БАЗЫ.txt"

    def clear_startup_error(self):
        """Удалить файл с прошлой ошибкой, чтобы он не путал после успешного запуска"""
        try:
            self._startup_error_file().unlink(missing_ok=True)
        except Exception as e:
            print(f"Не удалось удалить старый файл с описанием ошибки: {e}")

    def write_startup_error(self, error):
        """Сохранить сообщение об ошибке запуска в backups/ОШИБКА_БАЗЫ.txt"""
        try:
            import server
            if not isinstance(error, server.DatabaseIntegrityError):
                return
            server.BACKUP_DIR.mkdir(parents=True, exist_ok=True)
            report = self._startup_error_file()
            report.write_text(
                f"{datetime.now().isoformat(timespec='seconds')}\n{error}\n",
                encoding="utf-8",
            )
            print(f"Подробности сохранены в {report}")
        except Exception as e:
            print(f"Не удалось сохранить файл с описанием ошибки: {e}")

    def wait_for_server_start(self):
        """Ожидание запуска сервера (поллинг порта из главного потока Qt)"""
        self._start_attempts = 0
        self._start_timer = QTimer()
        self._start_timer.timeout.connect(self._check_server_started)
        self._start_timer.start(1000)

    def _check_server_started(self):
        self._start_attempts += 1
        if self.is_port_in_use(PORT):
            self._start_timer.stop()
            self.is_server_running = True
            self.status_action.setText(f"Статус: Работает (порт {PORT})")
            print(f"Сервер запущен на порту {PORT}")
            self.open_browser()
        elif self._start_attempts >= 30:
            self._start_timer.stop()
            self.status_action.setText("Статус: Ошибка запуска")
            print("Сервер не запустился за 30 секунд")
        
    def check_server_status(self):
        """Периодическая проверка статуса сервера"""
        if self.is_port_in_use(PORT):
            if not self.is_server_running:
                self.is_server_running = True
                self.status_action.setText(f"Статус: Работает (порт {PORT})")
        else:
            if self.is_server_running:
                self.is_server_running = False
                self.status_action.setText("Статус: Остановлен")
                self.tray_icon.showMessage(
                    "Склад IT-техники",
                    "Сервер остановлен",
                    QSystemTrayIcon.Warning,
                    3000
                )
                
    def stop_server(self):
        """Корректная остановка сервера: дослуживаем активные запросы и закрываем сокет"""
        if self.httpd is not None:
            try:
                if self.server_thread is not None and self.server_thread.is_alive():
                    self.httpd.shutdown()
                self.httpd.server_close()
                print("Сервер остановлен")
            except Exception as e:
                print(f"Ошибка при остановке сервера: {e}")
            self.httpd = None
        if self.server_thread is not None:
            self.server_thread.join(timeout=5)
            self.server_thread = None
        self.is_server_running = False
        self.status_action.setText("Статус: Остановлен")

    def backup_database(self):
        """Резервная копия базы данных"""
        try:
            import server
            dest = server.auto_backup()
            if dest:
                print(f"Резервная копия: {dest}")
        except Exception as e:
            print(f"Не удалось создать резервную копию: {e}")

    def restart_server(self):
        """Перезапуск сервера"""
        if self.httpd is None and self.is_port_in_use(PORT):
            self.tray_icon.showMessage(
                "Склад IT-техники",
                "Сервер запущен другим процессом — перезапуск из трея невозможен.",
                QSystemTrayIcon.Warning,
                3000
            )
            return
        self.stop_server()
        self.tray_icon.showMessage(
            "Склад IT-техники",
            "Сервер перезапускается...",
            QSystemTrayIcon.Information,
            2000
        )
        self.start_server()

    def open_browser(self):
        """Открытие приложения в браузере"""
        if not self.is_server_running:
            print("Сервер не запущен. Запускаю...")
            self.start_server()
            return
            
        print(f"Открытие браузера: {URL}")
        try:
            webbrowser.open(URL, new=2)  # new=2 открывает в новой вкладке
        except Exception as e:
            print(f"Ошибка открытия браузера: {e}")
        
    def quit_app(self):
        """Выход из приложения"""
        print("Выход из приложения")
        self.stop_server()
        self.backup_database()
        self.tray_icon.hide()
        # Удаляем файл блокировки
        try:
            if LOCK_FILE.exists():
                LOCK_FILE.unlink()
        except Exception as e:
            print(f"Не удалось удалить файл блокировки: {e}")
        self.app.quit()
        
    def run(self):
        """Запуск приложения"""
        return self.app.exec_()


def main():
    print("=" * 60)
    print("Склад IT-техники - System Tray Application")
    print("=" * 60)
    print(f"Рабочая директория: {ROOT}")
    print(f"URL: {URL}")
    print("=" * 60)
    
    app = WarehouseApp()
    sys.exit(app.run())


if __name__ == "__main__":
    main()
