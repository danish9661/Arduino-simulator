from machine import Pin, SPI
import time

CS_PIN = 17
SCK_PIN = 18
MOSI_PIN = 19
MISO_PIN = 16

cs = Pin(CS_PIN, Pin.OUT, value=1)
spi = SPI(
    0,
    baudrate=1_000_000,
    polarity=0,
    phase=0,
    sck=Pin(SCK_PIN),
    mosi=Pin(MOSI_PIN),
    miso=Pin(MISO_PIN),
)


def xfer(value):
    buf = bytearray(1)
    spi.write_readinto(bytes([value & 0xFF]), buf)
    return buf[0]


def sd_wait_response(limit=300):
    for _ in range(limit):
        r = xfer(0xFF)
        if (r & 0x80) == 0:
            return r
    return 0xFF


def sd_command(cmd, arg, crc):
    cs(0)
    xfer(0x40 | (cmd & 0x3F))
    xfer((arg >> 24) & 0xFF)
    xfer((arg >> 16) & 0xFF)
    xfer((arg >> 8) & 0xFF)
    xfer(arg & 0xFF)
    xfer(crc & 0xFF)
    return sd_wait_response()


def sd_release():
    cs(1)
    xfer(0xFF)


def sd_read_block(block_index):
    r1 = sd_command(17, block_index, 0x01)
    print("PY_SD_CMD17_R1", hex(r1))
    if r1 != 0x00:
        sd_release()
        return None

    token = 0xFF
    for _ in range(800):
        token = xfer(0xFF)
        if token != 0xFF:
            break

    print("PY_SD_READ_TOKEN", hex(token))
    if token != 0xFE:
        sd_release()
        return None

    payload = bytearray(512)
    for i in range(512):
        payload[i] = xfer(0xFF)

    xfer(0xFF)
    xfer(0xFF)
    sd_release()
    return payload


def sd_write_block(block_index, payload):
    r1 = sd_command(24, block_index, 0x01)
    print("PY_SD_CMD24_R1", hex(r1))
    if r1 != 0x00:
        sd_release()
        return False

    xfer(0xFF)
    xfer(0xFE)
    for b in payload:
        xfer(b)
    xfer(0xFF)
    xfer(0xFF)

    data_response = xfer(0xFF) & 0x1F
    print("PY_SD_WRITE_TOKEN", hex(data_response))

    for _ in range(400):
        if xfer(0xFF) == 0xFF:
            break

    sd_release()
    return data_response == 0x05


print("PY_SD_SPI_DEMO_BOOT")

for _ in range(12):
    xfer(0xFF)

r0 = sd_command(0, 0, 0x95)
print("PY_SD_CMD0_R1", hex(r0))
sd_release()

r8 = sd_command(8, 0x000001AA, 0x87)
print("PY_SD_CMD8_R1", hex(r8))
for _ in range(4):
    xfer(0xFF)
sd_release()

r55 = sd_command(55, 0, 0x01)
print("PY_SD_CMD55_R1", hex(r55))
sd_release()

r41 = sd_command(41, 0x40000000, 0x01)
print("PY_SD_ACMD41_R1", hex(r41))
sd_release()

r58 = sd_command(58, 0, 0x01)
print("PY_SD_CMD58_R1", hex(r58))
for _ in range(4):
    xfer(0xFF)
sd_release()

block = sd_read_block(0)
if block is not None:
    print("PY_SD_READ_B0", hex(block[0]), hex(block[1]), hex(block[2]))

payload = bytearray(512)
for i in range(512):
    payload[i] = i & 0xFF

print("PY_SD_WRITE_B2", "OK" if sd_write_block(2, payload) else "FAIL")

while True:
    print("PY_SD_SPI_HEARTBEAT")
    time.sleep(2)
