#!/bin/bash
echo "vm.swappiness = 20" | sudo tee -a /etc/sysctl.conf
echo Finshed setting vm.swappiness to 20
sudo apt update
sudo apt dist-upgrade -y
echo Finished dist-upgrading
sudo apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --recv 2930ADAE8CAF5059EE73BB4B58712A2291FA4AD5
echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu xenial/mongodb-org/3.6 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-3.6.list
sudo apt update
sudo apt install -y mongodb-org
echo Finished installing mongodb 3.6
sudo service mongod start
echo MongoDB started
curl -sL https://deb.nodesource.com/setup_8.x | sudo -E bash -
sudo apt install -y nodejs
echo NodeJS installed
sudo apt install -y htop
echo htop installed
cd ~
git clone https://github.com/iaace-NA/Supportbot
echo Finshed cloning repository
sudo npm install pm2 -g
echo Finished installing pm2 via npm global
cd api
npm install
echo Finished installing IAPI deps
cd ../discord
npm install
echo Finished installing discord deps
cd ../
echo "Setup script complete. The following needs to be completed by the user:\nAdd config file\nAdd TLS files\nRestart system\nRun startup script in start folder"

