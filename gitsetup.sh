cd src
rm -Rf gitrepo
mkdir gitrepo
cd gitrepo
git clone $1 .
cp -Rf ../spring-weather-service/* .
git add .
git commit -m "Initial commit"
git push