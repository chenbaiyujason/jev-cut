from PIL import Image
import sys
images=[Image.open(file).convert('RGB') for file in sys.argv[2:]]
canvas=Image.new('RGB',(sum(im.width for im in images),max(im.height for im in images)),(16,16,20))
x=0
for im in images:canvas.paste(im,(x,0));x+=im.width
canvas.save(sys.argv[1],quality=88)
