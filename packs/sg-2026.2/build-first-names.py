#!/usr/bin/env python3
"""
Construit packs/sg-2026.2/first-names.json : noms d'usage du socle Singapour v2, conditionnés par le groupe
(ethnie des résidents ou nationalité des étrangers), la RELIGION, le sexe et la génération.
Le reste des tables est hérité de packs/sg (sg-2026.1, inchangé). Relancer : python3 packs/sg-2026.2/build-first-names.py

Règle de tirage (src/personas/countries/sg/sampler.ts) : dans un groupe, les cohortes dont `religions`
contient la religion tirée passent en premier ; sinon la cohorte par défaut du groupe (sans `religions`).
Chaque groupe a une cohorte par défaut neutre pour les religions minoritaires qu'il ne déclare pas.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

def short(name):
    n = name.strip()
    for sep in [" bin ", " binte ", " binti ", " s/o ", " d/o ", " a/l ", " a/p "]:
        if sep in n:
            n = n.split(sep)[0]
    return n

CH_SURNAMES = ["Tan", "Lim", "Lee", "Ng", "Ong", "Wong", "Goh", "Chua", "Chan", "Koh", "Teo", "Ang", "Yeo", "Tay", "Ho", "Low", "Toh", "Sim", "Chong", "Chia"]
def chinese_display(full):
    parts = full.split()
    if parts[0] in CH_SURNAMES:
        return full
    if len(parts) >= 2 and parts[1] in CH_SURNAMES:
        return f"{parts[0]} {parts[1]}"
    return full

ISLAM = ["islam"]
CHRISTIAN = ["christianity"]
HINDU = ["hinduism"]
SIKH = ["sikhism"]
BUDDHIST = ["buddhism"]

# (groupe, sexe, génération, religions ou None pour la cohorte par défaut) → noms
N = [
    # ── Chinese résidents (et Malaisiens d'ethnie chinoise) ──
    # Défaut (bouddhistes, taoïstes, sans religion…) : prénom anglais courant ou nom chinois, sans prénom biblique marqué.
    ("chinese", "M", 0, None, "Tan Ah Kow, Lim Kim Huat, Ng Boon Heng, Ong Teck Seng, Goh Chin Huat, Lee Kok Wah, Chua Beng Hock, Koh Soon Lee, Teo Ah Seng, Wong Kum Fatt, Chan Wai Keong, Yeo Hock Chye, Tay Eng Soon, Low Kian Seng, Sim Ah Huat, Ho Yew Kong, David Lim Swee Hock, Richard Ng, Michael Goh, Henry Lee, Raymond Teo, Robert Koh, William Chan"),
    ("chinese", "M", 1, None, "Jason Tan Wei Ming, Kelvin Lim Chee Wei, Desmond Ng Kok Leong, Alvin Ong Boon Kiat, Eric Goh, Benjamin Lee, Gary Chua, Terence Koh, Daniel Teo, Kenneth Wong, Edwin Chan, Melvin Yeo, Derrick Tay, Andy Low, Vincent Sim, Marcus Ho, Shawn Tan, Jeremy Lim, Leonard Ng, Clarence Ong, Wilson Goh, Eugene Lee, Ivan Chua, Benny Koh, Nicholas Teo"),
    ("chinese", "M", 2, None, "Ryan Tan Jun Jie, Ethan Lim Zhi Hao, Javier Ng Jia Hui, Lucas Ong Yi Xuan, Bryan Goh Jun Wei, Ian Lee Kai Wen, Darren Chua Zheng Yang, Tan Wei Jie, Nathan Tay, Aaron Sim, Dylan Ho, Jayden Tan, Brandon Lim, Sean Ng, Marcus Goh Yu Xiang, Glenn Teo, Lim Zhi Hao, Ng Jun Kai, Koh Jia Le, Ryan Wong, Kenneth Chan"),
    ("chinese", "F", 0, None, "Tan Siew Hoon, Lim Bee Lian, Ng Ah Moi, Ong Lay Choo, Goh Swee Lan, Lee Mei Ling, Chua Geok Hwa, Koh Poh Choo, Teo Lay Hong, Wong Siew Kim, Chan Kwai Fong, Yeo Bee Hoon, Tay Chwee Lian, Low Siok Eng, Sim Gek Choo, Ho Mui Keow, Jenny Lim, Susan Ng, Doris Ong, Betty Goh, Helen Lee, Irene Chua, Lily Koh, Margaret Wong"),
    ("chinese", "F", 1, None, "Michelle Lim Hui Ling, Jasmine Tan Pei Shan, Angeline Ng, Serene Ong Siew Ling, Cheryl Goh, Joanne Lee, Shirley Chua, Wendy Koh, Doreen Teo, Karen Wong, Evelyn Chan, Elaine Yeo, Jacqueline Tay, Felicia Low, Pauline Sim, Sharon Ho, Valerie Tan, Adeline Lim, Rachel Ng, Vivian Ong, Germaine Goh, Audrey Lee, Yvonne Koh"),
    ("chinese", "F", 2, None, "Chloe Lim Xin Yi, Rachel Tan Hui Min, Natalie Ng Jia Yi, Sarah Ong Wen Qi, Charlotte Goh, Megan Lee Shu Ting, Nicole Chua, Valerie Koh Yu Ting, Ashley Teo, Isabelle Yeo, Claire Tay, Gwendolyn Low, Vanessa Sim, Amanda Ho, Joey Tan, Samantha Lim, Kimberly Ng, Clarissa Ong, Kaelyn Teo, Tan Hui Min, Lim Xin Yi"),
    # Chrétiens : prénom anglais souvent biblique ou de saint + nom chinois.
    ("chinese", "M", 0, CHRISTIAN, "Peter Tan, Paul Lim, John Ng, Joseph Goh, Francis Lee, Michael Ong, Thomas Chua, Stephen Teo, David Koh, Philip Wong, Anthony Chan, Patrick Yeo"),
    ("chinese", "M", 1, CHRISTIAN, "Daniel Tan, Samuel Lim, Stephen Ng, Paul Goh, Matthew Lee, Timothy Ong, Andrew Chua, Jonathan Teo, Mark Koh, Peter Wong, Joseph Lim, Simon Tan, Benjamin Chan"),
    ("chinese", "M", 2, CHRISTIAN, "Joshua Koh, Samuel Tan, Caleb Lim, Nathaniel Ng, Elijah Goh, Isaac Lee, Gabriel Ong, Timothy Chua, Jonathan Teo, Joel Wong, Aaron Tan, Matthias Lim, Matthew Teo, Zachary Ong"),
    ("chinese", "F", 0, CHRISTIAN, "Mary Tan, Theresa Lim, Agnes Ng, Margaret Goh, Catherine Lee, Rose Ong, Esther Chua, Ruth Teo, Grace Wong, Lucy Koh, Monica Chan"),
    ("chinese", "F", 1, CHRISTIAN, "Grace Tan, Esther Lim, Ruth Ng, Rebecca Goh, Deborah Lee, Faith Ong, Joy Chua, Hannah Teo, Elizabeth Koh, Christine Wong, Priscilla Teo, Lydia Tan"),
    ("chinese", "F", 2, CHRISTIAN, "Hannah Tan, Grace Lim, Abigail Ng, Rebecca Goh, Esther Lee, Naomi Ong, Faith Chua, Joanna Teo, Leah Wong, Rachel Tan, Sarah Lim, Abigail Chan"),
    # Musulmans d'ethnie chinoise (convertis, souvent par mariage) : nom musulman + nom chinois.
    ("chinese", "M", 9, ISLAM, "Muhammad Hafiz Tan, Abdullah Lim, Muhammad Iskandar Ng, Ismail Lee, Ahmad Ong, Muhammad Ali Goh"),
    ("chinese", "F", 9, ISLAM, "Nur Aisyah Tan, Siti Mariam Lim, Aishah Ng, Khadijah Goh, Nurul Huda Lee, Fatimah Ong"),

    # ── Malays (98,6 % musulmans) ──
    ("malay", "M", 0, ISLAM, "Abdul Rahman bin Osman, Mohamed Yusof bin Ahmad, Ismail bin Hassan, Ahmad bin Salleh, Osman bin Ali, Hamzah bin Ibrahim, Yaacob bin Mohd Noor, Sulaiman bin Abdullah, Jamaludin bin Kassim, Zainal bin Ariffin, Rahim bin Jaafar, Salleh bin Ismail, Hashim bin Yusof, Abu Bakar bin Hussein, Kamaruddin bin Mahmood, Ibrahim bin Sapari, Aziz bin Rahmat, Rosli bin Ahmad, Mansor bin Hamid, Hussin bin Omar, Daud bin Musa, Samad bin Kadir, Latiff bin Ismail"),
    ("malay", "M", 1, ISLAM, "Mohamed Faizal bin Abdul Rahman, Muhammad Hafiz bin Ismail, Mohd Rizal bin Osman, Azman bin Hamzah, Khairul Anuar bin Yusof, Noor Azman bin Salleh, Shahrul Nizam bin Ali, Fadli bin Ibrahim, Zulkifli bin Hashim, Mohammad Iskandar bin Kassim, Hairul bin Jamal, Saiful Bahri bin Ahmad, Norman bin Abdullah, Rahmat bin Sulaiman, Firdaus bin Abu Bakar, Ridzuan bin Zainal, Faizal bin Daud, Azhar bin Mansor, Shamsul bin Kamaruddin, Effendy bin Latiff, Suhaimi bin Jaafar"),
    ("malay", "M", 2, ISLAM, "Muhammad Danial bin Mohamed Faizal, Muhammad Haziq bin Azman, Muhammad Irfan bin Rizal, Muhammad Aqil bin Khairul, Ahmad Syafiq bin Zulkifli, Muhammad Amirul bin Hafiz, Adam Rayyan bin Fadli, Ariff bin Saiful, Muhammad Iman bin Hairul, Harith bin Ridzuan, Imran bin Firdaus, Aidil bin Azhar, Muhammad Faris bin Norman, Hakim bin Rahmat, Luqman bin Effendy, Afiq bin Hamid, Nabil bin Iskandar, Ilyas bin Faizal, Danish bin Shamsul, Aliff bin Zainal"),
    ("malay", "F", 0, ISLAM, "Siti Aminah binte Hassan, Fatimah binte Ahmad, Rokiah binte Osman, Zainab binte Ismail, Aishah binte Salleh, Maimunah binte Ali, Khadijah binte Ibrahim, Halimah binte Yusof, Rahmah binte Jaafar, Salmah binte Kassim, Mariam binte Abdullah, Zaleha binte Hamid, Jamilah binte Musa, Asmah binte Said, Hasnah binte Omar, Rohani binte Mahmood, Norma binte Rahim, Hamidah binte Daud, Ramlah binte Ariffin, Kalsom binte Sapari, Normah binte Latiff"),
    ("malay", "F", 1, ISLAM, "Norhayati binte Abdul Rahman, Nurul Huda binte Ismail, Siti Nurhaliza binte Osman, Suhaila binte Ahmad, Noraini binte Hamzah, Rosnah binte Yusof, Juliana binte Salleh, Haslinda binte Ali, Norazlina binte Ibrahim, Zuraidah binte Hashim, Nurhayati binte Kassim, Faridah binte Jamal, Rahayu binte Abdullah, Noor Aisyah binte Sulaiman, Hidayah binte Abu Bakar, Syazwani binte Zainal, Liyana binte Rahim, Suriani binte Daud, Azizah binte Mansor, Nadiah binte Kamaruddin, Marlina binte Latiff"),
    ("malay", "F", 2, ISLAM, "Nur Aisyah binte Mohamed Faizal, Nur Syafiqah binte Azman, Nurul Ain binte Rizal, Siti Nur Alya binte Khairul, Nur Izzati binte Zulkifli, Nur Atiqah binte Hafiz, Alya Qistina binte Fadli, Nur Farhana binte Shahrul, Aqilah binte Saiful, Nur Hidayah binte Hairul, Syafiqah binte Ridzuan, Nadhirah binte Firdaus, Insyirah binte Azhar, Nur Amirah binte Norman, Hannah binte Rahmat, Sofea binte Effendy, Zahra binte Hamid, Nabilah binte Iskandar, Dayana binte Hasbullah, Qistina binte Faizal, Iman binte Azhar"),
    # Défaut (Malays non musulmans, ≈ 1,4 %) : prénoms malais d'origine sanskrite ou indonésienne, sans marque religieuse.
    ("malay", "M", 9, None, "Indra Putra, Bayu Wira, Andika Jaya, Wira Perkasa, Ratno Saputra"),
    ("malay", "F", 9, None, "Dewi Kartika, Intan Sari, Melati Ayu, Ratna Juwita, Putri Mawar"),

    # ── Indians résidents (et Malaisiens d'ethnie indienne) ──
    # Défaut (hindous, et sans religion, bouddhistes… d'origine hindoue) : noms tamouls et malayalis hindous.
    ("indian", "M", 0, None, "Ramasamy s/o Muthu, Krishnan s/o Subramaniam, Govindasamy s/o Perumal, Rajendran s/o Arumugam, Selvaraj s/o Kandasamy, Murugesan s/o Ponnusamy, Nadarajah s/o Velu, Balakrishnan s/o Raman, Gopal s/o Sinnathamby, Maniam s/o Karuppiah, Thangaraju s/o Veerasamy, Sivalingam s/o Ramu, Jayakumar s/o Rajoo, Narayanan Nair"),
    ("indian", "M", 1, None, "Suresh Kumar s/o Rajendran, Ravi Chandran s/o Krishnan, Ganesh s/o Selvaraj, Vijay s/o Murugesan, Ramesh s/o Balakrishnan, Senthil Kumar s/o Gopal, Prakash s/o Nadarajah, Anand s/o Maniam, Kumar s/o Thangaraju, Saravanan s/o Sivalingam, Kannan s/o Govindasamy, Mohan s/o Ramasamy, Rajesh s/o Jayakumar, Sanjay Nair, Arvind Menon, Dinesh s/o Raman"),
    ("indian", "M", 2, None, "Arjun s/o Suresh Kumar, Rishi s/o Ravi Chandran, Karthik s/o Ganesh, Vikram s/o Vijay, Pravin s/o Ramesh, Naveen s/o Senthil Kumar, Darshan s/o Prakash, Rohan s/o Anand, Kishore s/o Kumar, Harish s/o Kannan, Aravind s/o Mohan, Sachin s/o Rajesh, Adithya Nair, Rahul Menon, Sharvin s/o Dinesh, Akash s/o Kalai"),
    ("indian", "F", 0, None, "Lakshmi d/o Krishnan, Saraswathy d/o Ramasamy, Kamala d/o Muthu, Pushpa d/o Subramaniam, Meenakshi d/o Perumal, Valli d/o Arumugam, Rajeswari d/o Kandasamy, Saroja d/o Velu, Indrani d/o Govindasamy, Vasantha d/o Maniam, Kalaiselvi d/o Nadarajah, Parvathi d/o Raman"),
    ("indian", "F", 1, None, "Kavitha d/o Rajendran, Shanthi d/o Krishnan, Malathi d/o Selvaraj, Revathi d/o Murugesan, Geetha d/o Balakrishnan, Vasuki d/o Gopal, Sangeetha d/o Nadarajah, Anitha d/o Maniam, Uma d/o Thangaraju, Jayanthi d/o Sivalingam, Priya Nair, Deepa Menon, Sumathi d/o Kannan, Selvi d/o Jayakumar"),
    ("indian", "F", 2, None, "Priya d/o Suresh Kumar, Divya d/o Ravi Chandran, Shalini d/o Ganesh, Nisha d/o Vijay, Keerthana d/o Ramesh, Harini d/o Senthil Kumar, Sneha d/o Prakash, Kavya d/o Anand, Swathi d/o Kumar, Deepika d/o Saravanan, Janani d/o Kannan, Sruthi d/o Mohan, Anjali Nair, Meera Menon, Varsha d/o Kalai"),
    # Musulmans (22,5 % des Indians) : noms tamouls musulmans et indiens musulmans.
    ("indian", "M", 0, ISLAM, "Mohamed Ibrahim s/o Abdul Kader, Abdul Kader s/o Mohamed Ismail, Syed Ali, Mohamed Ismail s/o Kader Mydin, Kader Mydin, Abdul Gaffoor, Sheik Dawood, Mohamed Hussain, Noor Mohamed, Abdul Razak s/o Abdul Majeed"),
    ("indian", "M", 1, ISLAM, "Mohamed Farouk s/o Mohamed Ibrahim, Mohamed Rafi, Syed Ibrahim, Abdul Rahim s/o Abdul Kader, Imran Khan, Riyaz Ahmed, Mohamed Irshad, Shahul Hameed, Jaffar Sadiq, Mohamed Nazir"),
    ("indian", "M", 2, ISLAM, "Muhammad Irfan s/o Shamsul Ariff, Farhan s/o Mohamed Rafi, Mohamed Arshad, Imran s/o Riyaz Ahmed, Adnan Khan, Rizwan s/o Shahul Hameed, Faizal Rahman, Ashiq s/o Jaffar Sadiq, Zubair Ahmed, Rayyan s/o Mohamed Nazir"),
    ("indian", "F", 0, ISLAM, "Fatimah Bee d/o Abdul Kader, Kadeeja Bee, Mumtaz Begum, Ayesha Bee, Rahmath Bee, Jameela d/o Syed Ali, Hajara Bee, Zubaida Begum, Sabeena d/o Mohamed Hussain"),
    ("indian", "F", 1, ISLAM, "Fathima d/o Mohamed Ibrahim, Farah Banu d/o Abdul Rahim, Noorjahan, Shahida Begum, Rizwana d/o Syed Ibrahim, Farzana, Shabnam, Nasreen Banu, Ayesha d/o Mohamed Rafi, Rukhsana"),
    ("indian", "F", 2, ISLAM, "Aisha Banu d/o Shamsul Ariff, Ayesha d/o Imran Khan, Farhana, Sana Khan, Aafiya d/o Riyaz Ahmed, Zara Rahman, Hafsa, Nusrath Banu, Sumaiya, Afreen"),
    # Sikhs (3,4 %) : Singh et Kaur.
    ("indian", "M", 0, SIKH, "Gurdev Singh, Harbans Singh, Karam Singh, Gurmit Singh, Bachan Singh"),
    ("indian", "M", 1, SIKH, "Jaspal Singh, Kuldip Singh, Jasbir Singh, Harpreet Singh, Manjit Singh"),
    ("indian", "M", 2, SIKH, "Gurpreet Singh, Amrit Singh, Jaskaran Singh, Harjot Singh, Arjan Singh Gill"),
    ("indian", "F", 0, SIKH, "Jaswant Kaur, Gurmit Kaur, Surinder Kaur, Gurdial Kaur, Pritam Kaur"),
    ("indian", "F", 1, SIKH, "Harpreet Kaur, Manjit Kaur, Jaswinder Kaur, Rajinder Kaur, Sukhvinder Kaur"),
    ("indian", "F", 2, SIKH, "Simran Kaur, Navneet Kaur, Harleen Kaur, Gurleen Kaur, Jasleen Kaur"),
    # Chrétiens (10,8 %) : catholiques tamouls, chrétiens malayalis, noms d'origine portugaise.
    ("indian", "M", 0, CHRISTIAN, "George Thomas, Joseph Mathew, Anthony s/o Arokiasamy, Peter Fernandez, Xavier s/o Savarimuthu, Thomas Varghese, John Pillai, Paul Samuel"),
    ("indian", "M", 1, CHRISTIAN, "Joseph s/o Anthony, Jacob Thomas, Francis Xavier, Stephen Raj, Michael Fernandez, Philip Mathew, Antony Selvam, Jonathan Pereira"),
    ("indian", "M", 2, CHRISTIAN, "Samuel Raj, Daniel Joseph, Joshua Thomas, Ryan D'Silva, Aaron Mathews, Nathaniel s/o Stephen Raj, Jeremy Fernandez, Joel Varghese"),
    ("indian", "F", 0, CHRISTIAN, "Mary Joseph, Annamma Thomas, Theresa d/o Arokiasamy, Rosaline d/o Anthony, Agnes Fernandez, Philomena d/o Xavier, Elizabeth Varghese"),
    ("indian", "F", 1, CHRISTIAN, "Jennifer Fernandez, Jacintha d/o Joseph, Christina Raj, Sharon Thomas, Grace Mathew, Stella d/o Anthony, Mary Varghese"),
    ("indian", "F", 2, CHRISTIAN, "Shania Fernandez, Rachel Joseph, Hannah Thomas, Michelle Samuel, Sharon Mathews, Christina d/o Stephen Raj, Abigail D'Silva"),

    # ── Others résidents (Eurasiens, Arabes, Thaïs, Japonais… naturalisés ou PR) ──
    ("others", "M", 9, None, "Desmond De Souza, Gerald Pereira, Kevin Rodrigues, Shaun Oliveiro, Clement D'Cruz, Mark Fernandez, Brian Scully, Daniel Martens, Joshua Schoon, Ryan Danker, Nathaniel Gomes, Jerome Theseira, Mark Anthony Santos, Joel Reyes"),
    ("others", "F", 9, None, "Melissa De Souza, Gwendolyn Pereira, Andrea Rodrigues, Sheryl D'Cruz, Natasha Fernandez, Christine Martens, Leanne Danker, Bernadette Gomes, Rebecca Theseira, Patricia Westerhout, Maria Cristina Dela Cruz, Joanna Garcia"),
    ("others", "M", 9, ISLAM, "Syed Omar Alsagoff, Syed Hassan Aljunied, Omar Alkaff, Sharif Alhabshee, Adam Hussain, Ali Ahmad Bajrai"),
    ("others", "F", 9, ISLAM, "Sharifah Aljunied, Sharifah Nur Alsagoff, Aminah Alkaff, Farah Alhabshee, Mariam Bajrai, Noor Hussain"),
    ("others", "M", 9, BUDDHIST, "Somchai Ratanapong, Nimal Jayasuriya, Kenji Tanaka, Aung Min Thein, Sunil Wickramasinghe, Hiroshi Yamada"),
    ("others", "F", 9, BUDDHIST, "Siriporn Chaiyasit, Kumari Jayasuriya, Yuki Tanaka, Thida Win, Chamari Wickramasinghe, Haruka Yamada"),
    ("others", "M", 9, HINDU, "Bishnu Gurung, Ramesh Thapa, Hari Rai, Dil Bahadur Gurung"),
    ("others", "F", 9, HINDU, "Sunita Gurung, Gita Thapa, Maya Rai, Laxmi Gurung"),

    # ── Étrangers ──
    # Bangladais : musulmans (90 %), hindous (9 %), défaut bouddhiste ou chrétien (Barua, Chakma, Gomes).
    ("bangladesh", "M", 9, ISLAM, "Md. Rahim Uddin, Mohammad Hossain, Abdul Karim, Rubel Mia, Md. Alamgir Hossain, Sumon Ahmed, Shohag Mia, Md. Jahangir Alam, Rasel Sheikh, Md. Shahidul Islam, Kamrul Hasan, Md. Abul Kalam, Mizanur Rahman, Rakib Hasan, Habibur Rahman, Md. Sohel Rana, Masud Rana, Faruk Hossain, Shafiqul Islam, Nur Alam"),
    ("bangladesh", "F", 9, ISLAM, "Nasrin Akter, Rokeya Begum, Shirin Akter, Taslima Begum"),
    ("bangladesh", "M", 9, HINDU, "Sujon Das, Ratan Chandra Das, Gopal Saha, Biplob Sarker, Shyamal Kumar Roy, Pradip Biswas, Uttam Ghosh, Nikhil Chandra Dey"),
    ("bangladesh", "F", 9, HINDU, "Shila Rani Das, Mitu Saha, Rupa Rani Roy, Anjali Biswas"),
    ("bangladesh", "M", 9, None, "Sumon Barua, Rony Gomes, Pintu Chakma, Tapan Barua"),
    ("bangladesh", "F", 9, None, "Mitu Barua, Rina Gomes, Shanti Chakma"),
    # Indiens Work Permit (Tamil Nadu surtout) : défaut hindou.
    ("india_wp", "M", 9, None, "Murugan Selvam, Karthik Raja, Arun Kumar, Prakash Murugesan, Vignesh Pandian, Sakthivel Ramasamy, Manikandan Velu, Ramesh Kannan, Balamurugan Arumugam, Senthil Perumal, Muthukumar Raju, Suresh Ponnusamy, Ajith Kumar, Dinesh Babu, Gopi Krishnan, Raja Sekar, Sathish Kumar, Vinoth Kumar, Elango Durai"),
    ("india_wp", "F", 9, None, "Selvi Murugan, Pandeeswari Raju, Muthulakshmi Velu, Kalaivani Selvam"),
    ("india_wp", "M", 9, ISLAM, "Mohamed Riyas, Sheik Mohideen, Mohamed Asif, Syed Ibrahim, Jahir Hussain, Abdul Rahman Basha"),
    ("india_wp", "F", 9, ISLAM, "Fathima Beevi, Ayesha Banu, Rasheeda Begum"),
    ("india_wp", "M", 9, CHRISTIAN, "Arockia Raj, Antony Samy, Joseph Raj, Xavier Selvam, John Britto"),
    ("india_wp", "F", 9, CHRISTIAN, "Mary Selvi, Arockia Mary, Jency Rani"),
    ("india_wp", "M", 9, SIKH, "Gurpreet Singh, Harjit Singh, Balwinder Singh"),
    ("india_wp", "F", 9, SIKH, "Jaspreet Kaur, Amandeep Kaur"),
    # Indiens qualifiés (EP, S Pass, dépendants, étudiants ; Sri Lankais d'ethnie indienne) : défaut hindou.
    ("india_pro", "M", 9, None, "Rahul Sharma, Arvind Kumar, Vikram Reddy, Amit Gupta, Rohit Agarwal, Sanjay Iyer, Karthik Subramanian, Nikhil Jain, Ankit Verma, Siddharth Rao, Pranav Kulkarni, Varun Mehta, Abhishek Mishra, Vivek Nair"),
    ("india_pro", "F", 9, None, "Priya Nair, Ananya Iyer, Sneha Patel, Pooja Sharma, Divya Reddy, Neha Gupta, Kavya Rao, Shruti Agarwal, Meghna Menon, Aishwarya Krishnan, Ritu Jain, Swati Kulkarni, Nandini Shah, Deepa Pillai, Anjali Verma"),
    ("india_pro", "M", 9, ISLAM, "Mohammed Arif, Imran Qureshi, Faisal Khan, Syed Ahmed, Aamir Sheikh, Zaid Ansari, Tariq Siddiqui, Salman Hussain"),
    ("india_pro", "F", 9, ISLAM, "Ayesha Khan, Sana Sheikh, Fatima Siddiqui, Zainab Ansari, Nazia Qureshi, Farah Hussain"),
    ("india_pro", "M", 9, CHRISTIAN, "Thomas Mathew, Jacob Varghese, Joseph D'Souza, Ashwin Fernandes, Kevin George, Jose Kurian"),
    ("india_pro", "F", 9, CHRISTIAN, "Ann Mary Thomas, Riya Mathew, Neha D'Souza, Sneha Fernandes, Sharon George, Teresa Kurian"),
    ("india_pro", "M", 9, SIKH, "Harpreet Singh, Gurpreet Singh Sandhu, Manpreet Singh, Jaskirat Singh Bedi"),
    ("india_pro", "F", 9, SIKH, "Simran Kaur, Harleen Kaur Sandhu, Manpreet Kaur, Jasmeet Kaur"),
    # Chinois de Chine populaire, Vietnamiens, Japonais et Coréens : noms sans marque religieuse.
    ("china", "M", 9, None, "Wang Wei, Zhang Lei, Li Qiang, Liu Yang, Chen Jie, Yang Fan, Zhao Peng, Huang Hao, Zhou Jian, Wu Bin, Xu Ming, Sun Hao, Ma Jun, Zhu Tao, Hu Bo, Guo Liang, He Xin, Lin Feng, Gao Yu, Luo Kai"),
    ("china", "F", 9, None, "Li Na, Wang Fang, Zhang Min, Liu Jing, Chen Xiaoyan, Yang Li, Zhao Yan, Huang Ting, Zhou Yu, Wu Xue, Xu Qian, Sun Lei, Ma Li, Zhu Hong, Hu Mei, Guo Jing, He Yun, Lin Xiao, Gao Shan, Luo Yi"),
    # Philippins : défaut catholique (88 % chrétiens, et les sans religion) ; musulmans de Mindanao.
    ("philippines", "M", 9, None, "Mark Anthony Santos, John Paul Reyes, Jerome Dela Cruz, Christian Bautista, Ramon Garcia, Joel Mendoza, Ronald Villanueva, Arnel Aquino, Jayson Ramos, Rey Castillo"),
    ("philippines", "F", 9, None, "Maria Cristina Santos, Jocelyn Reyes, Marites Dela Cruz, Rowena Garcia, Analyn Bautista, Jennylyn Mendoza, Lorna Villanueva, Mary Grace Aquino, Rhea Ramos, Joy Castillo, Liza Fernandez, Cherry Ann Torres, Rosalie Flores, Mylene Navarro, Divina Pascual"),
    ("philippines", "M", 9, ISLAM, "Abdul Rahman Ampatuan, Nasser Pangandaman, Amir Mangudadatu, Jamal Alonto"),
    ("philippines", "F", 9, ISLAM, "Norhata Pangandaman, Sittie Aisah Macarambon, Jamila Alonto, Fatima Mangudadatu, Saida Ampatuan"),
    # Indonésiens : musulmans (88 %) ; chrétiens (Batak, Manado, Flores) ; défaut bouddhiste ou autre (sino-indonésiens).
    ("indonesia", "M", 9, ISLAM, "Agus Santoso, Budi Hartono, Eko Prasetyo, Joko Susilo, Rudi Hermawan, Muhammad Rizki, Ahmad Fauzi"),
    ("indonesia", "F", 9, ISLAM, "Siti Rohmah, Sri Wahyuni, Sumiati, Dewi Lestari, Tri Handayani, Ernawati, Yuliana, Nur Hasanah, Suryani, Rina Wati, Endang Susilowati, Wahyuningsih, Siti Khotimah, Lestari, Indah Permatasari, Fitri Yani, Ani Rahmawati, Sulastri, Kartini, Puji Astuti"),
    ("indonesia", "M", 9, CHRISTIAN, "Yohanes Simanjuntak, Daniel Sitompul, Yosef Manurung, Petrus Tambunan"),
    ("indonesia", "F", 9, CHRISTIAN, "Yohana Simanjuntak, Maria Magdalena Siahaan, Ruth Manurung, Agnes Tambunan, Debora Sihombing, Maria Goreti Bria"),
    ("indonesia", "M", 9, None, "Hendra Wijaya, Rudy Halim, Steven Gunawan, Wahyu Tanoto"),
    ("indonesia", "F", 9, None, "Lina Wijaya, Susanti Halim, Yenny Gunawan, Melinda Tanoto, Ni Made Sari"),
    # Birmans : défaut bouddhiste ; chrétiens (Karen, Kachin, Chin), musulmans, hindous (Indo-Birmans).
    ("myanmar", "M", 9, None, "Aung Ko Ko, Zaw Min Htet, Kyaw Zin Oo, Min Thu, Htet Aung"),
    ("myanmar", "F", 9, None, "Thandar Aye, Khin Myo Win, Nwe Nwe Oo, Aye Aye Mon, Su Su Hlaing, Ei Ei Phyo, May Thu Zar, Hnin Wai"),
    ("myanmar", "M", 9, CHRISTIAN, "Saw Eh Htoo, Lal Thang Lian, Zau Seng, Saw Paul"),
    ("myanmar", "F", 9, CHRISTIAN, "Naw Paw Htoo, Hkawn Nu, Esther Cing, Naw Mary"),
    ("myanmar", "M", 9, ISLAM, "Mohammed Ismail, Abdul Rashid, Aung Zaw Ali"),
    ("myanmar", "F", 9, ISLAM, "Aisha Thein, Mariam Khin, Fatima Win"),
    ("myanmar", "M", 9, HINDU, "Ram Kumar, Shiva Prasad, Gopal Das"),
    ("myanmar", "F", 9, HINDU, "Sita Devi, Lakshmi Devi, Radha Devi"),
    ("western", "M", 9, None, "James Wilson, Oliver Smith, Thomas Brown, Daniel Taylor, Matthew Johnson, Michael Davis, Benjamin Clarke, Andrew Thompson, Pierre Martin, Julien Dubois, Lukas Müller, Jan de Vries"),
    ("western", "F", 9, None, "Sophie Williams, Emma Brown, Charlotte Taylor, Emily Johnson, Hannah Smith, Laura Wilson, Rebecca Clarke, Claire Martin, Camille Bernard, Anna Schmidt, Sanne Jansen"),
    # Occidentaux et autres pays musulmans (Moyen-Orient, Afrique du Nord, Turquie, Europe).
    ("western", "M", 9, ISLAM, "Omar Haddad, Yusuf Demir, Ahmed Mansour, Karim Benali, Adam Hussain, Bilal Malik"),
    ("western", "F", 9, ISLAM, "Amira Haddad, Leila Mansour, Yasmin Demir, Sara Benali, Nadia Hussain, Aisha Malik"),
    ("east_asia", "M", 9, None, "Kenji Tanaka, Hiroshi Sato, Min-jun Kim, Ji-hoon Park, Takumi Yamamoto, Seung-ho Lee"),
    ("east_asia", "F", 9, None, "Yuki Suzuki, Ayaka Watanabe, Ji-yeon Lee, Seo-yeon Choi, Mei Nakamura, Hye-jin Kang"),
    ("vietnam", "M", 9, None, "Nguyen Van Minh, Tran Duc Anh, Le Hoang Nam, Pham Quoc Bao"),
    ("vietnam", "F", 9, None, "Nguyen Thi Lan, Tran Thu Trang, Le Thi Hoa, Pham Ngoc Anh, Vu Thanh Huong"),
    # Thaïs et autres Asiatiques : défaut bouddhiste ; musulmans du Sud thaïlandais ; hindous népalais.
    ("thailand", "M", 9, None, "Somchai Wongsakul, Anan Chaiyaporn, Prasert Srisuk, Kittipong Boonmee"),
    ("thailand", "F", 9, None, "Siriporn Kaewkla, Nattaya Thongdee, Ploy Rattanakorn, Malee Suksan"),
    ("thailand", "M", 9, ISLAM, "Abdulloh Samae, Ismail Yusoh, Muhammad Doloh"),
    ("thailand", "F", 9, ISLAM, "Fatimah Yusoh, Nurhayati Samae, Saripah Doloh"),
    # Hindous d'« un autre pays d'Asie » d'ethnie non indienne : Népalais surtout.
    ("thailand", "M", 9, HINDU, "Ramesh Thapa, Bikram Gurung, Hari Bahadur Rai"),
    ("thailand", "F", 9, HINDU, "Sunita Thapa, Gita Gurung, Maya Rai"),
]

COHORTS = {0: (1900, 1969), 1: (1970, 1989), 2: (1990, 2010), 9: (1900, 2010)}
cohorts = []
seen = set()
for group, sex, k, religions, names in N:
    key = (group, sex, k, tuple(religions or []))
    assert key not in seen, key
    seen.add(key)
    lst = [n.strip() for n in names.split(",") if n.strip()]
    disp = []
    for n in lst:
        d = chinese_display(n) if group == "chinese" else short(n)
        if d not in disp:
            disp.append(d)
    a, b = COHORTS[k]
    c = {"birthFrom": a, "birthTo": b, "sex": sex, "group": group}
    if religions:
        c["religions"] = religions
    c["names"] = [[n, round(1 + 0.6 * (len(disp) - i) / len(disp), 3)] for i, n in enumerate(disp)]
    cohorts.append(c)

table = {
    "id": "sg-first-names",
    "title": "Noms d'usage par ethnie ou nationalité, religion, sexe et génération",
    "assumption": True,
    "sources": [{"org": "ICA", "title": "Name registration conventions (English name, dialect or Hanyu Pinyin romanisation, bin/binte, s/o d/o)", "year": 2025, "url": "https://www.ica.gov.sg/"}],
    "justification": "Aucune statistique officielle des prénoms n'est publiée à Singapour : listes de formes usuelles réalistes par ethnie ou nationalité, religion, sexe et génération (romanisation dialectale avant les années 1980, prénom anglais et Hanyu Pinyin ensuite ; « bin / binte » et « s/o / d/o » retirés du nom d'usage), docs/research/socle-sg.md § 10. Le nom suit la religion tirée avant lui : Indiens musulmans (Mohamed, Fathima, Farhan, Ayesha), sikhs (Singh, Kaur), chrétiens (Joseph, Mary) ou hindous ; Chinois chrétiens à prénom biblique, les autres à prénom anglais courant ou chinois ; Malays musulmans ; Bangladais musulmans ou hindous ; Philippins catholiques ou musulmans ; Indonésiens musulmans ou chrétiens. Poids légèrement décroissants dans l'ordre des listes.",
    "notes": "Une cohorte avec `religions` ne sert qu'aux personas de ces religions ; la cohorte sans `religions` est le défaut du groupe (religions qu'aucune cohorte ne déclare). Le nom d'usage est celui par lequel la personne est désignée au quotidien (« Jason Tan », « Tan Siew Hoon », « Nur Aisyah », « Suresh Kumar »).",
    "data": {"cohorts": cohorts},
}
with open(os.path.join(HERE, "first-names.json"), "w", encoding="utf-8") as f:
    json.dump(table, f, ensure_ascii=False, indent=1)
    f.write("\n")
print(f"{len(cohorts)} cohortes écrites dans {HERE}/first-names.json")
