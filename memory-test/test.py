import time

x=bytearray(4*1024**3)
exec("while True:\n for i in range(0,len(x),4096): x[i]=(x[i]+1)%256\n time.sleep(.1)")

